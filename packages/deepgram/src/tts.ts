// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/deepgram/tts.py

/**
 * Deepgram text-to-speech service implementation.
 *
 * This module provides integration with Deepgram's text-to-speech API for
 * generating speech from text using various voice models.
 *
 * Porting notes:
 * - `DeepgramTTSService` connects with the global `WebSocket` through
 *   `WebsocketService._websocketConnect()`, sending the API key as the
 *   `Authorization: Token <key>` header on the opening handshake (Bun, Node
 *   and Deno; on Cloudflare Workers `websocketConnect` opens the socket through
 *   `fetch` so the header is sent there too). A standard `WebSocket` does not expose the
 *   handshake's response headers, so the `dg-*` headers upstream logs on
 *   connect are not available.
 * - `DeepgramHttpTTSService` uses `fetch`. Upstream's required
 *   `aiohttp_session` becomes an optional `fetch` function (defaults to the
 *   global `fetch`).
 * - Query values are written with JS number formatting, so a float with an
 *   integral value (`speed=1.0` upstream) is written `speed=1`.
 * - Deprecated APIs are not ported: the `voice` constructor option of both
 *   services.
 */

import { abortable, currentSignal, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  TTSService,
  type TTSServiceOptions,
  WebsocketTTSService,
  type WebsocketTTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State, type WebsocketConnectOptions } from "@pipedog/core/services/websocket_service";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { ipaPhones, normalizeIpa, stressBeforeVowels } from "@pipedog/core/utils/text/phonemes";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface DeepgramTTSSettingsOptions extends TTSSettingsOptions {
  /** Speech-rate multiplier, from 0.7 to 1.5. */
  speed?: number | null | NotGiven;
}

/**
 * Settings for DeepgramTTSService and DeepgramHttpTTSService.
 *
 * - `speed`: speech-rate multiplier, from 0.7 to 1.5. `null` leaves Aura at
 *   its default rate. Supported by the Aura-2 English and Spanish voices;
 *   Deepgram recommends staying at or above 0.9 for Spanish.
 */
export class DeepgramTTSSettings extends TTSSettings {
  speed: number | null | NotGiven = NOT_GIVEN;

  constructor(options: DeepgramTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

// Aura-2 rejects IPA that is far longer than the word it replaces, or longer
// than 128 characters. Short words get a floor instead of the ratio.
const _MAX_IPA_LENGTH = 128;
const _MAX_IPA_WORD_RATIO = 10;
const _MIN_IPA_LENGTH = 15;

/** Python's `len()` of a string: its number of code points. */
function pyLen(s: string): number {
  return [...s].length;
}

/**
 * Render a pronunciation as a Deepgram inline pronunciation object.
 *
 * Aura-2 reads an escaped JSON object anywhere in the text and speaks its
 * `pronounce` value in place of its `word`. The word stays in the text and is
 * what Deepgram bills for; the IPA is not billed. English and Spanish only.
 * Stress marks go directly before the vowel they stress; Aura-2 warns about
 * any other placement and falls back to a best-effort pronunciation.
 *
 * @param word The word being pronounced, kept as the object's `word`.
 * @param ipa The pronunciation, in IPA.
 * @returns The inline object, e.g.
 *   `\{"word": "dupilumab", "pronounce": "duːpˈɪljuːmæb"\}`, or null for an
 *   empty pronunciation or IPA longer than Deepgram accepts for the word.
 */
export function formatDeepgramPronunciation(word: string, ipa: string): string | null {
  const formatted = normalizeIpa(ipa)
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => stressBeforeVowels(ipaPhones(w)).join(""))
    .join(" ");
  if (!formatted || pyLen(formatted) > _MAX_IPA_LENGTH) {
    return null;
  }
  if (pyLen(formatted) > Math.max(_MAX_IPA_WORD_RATIO * pyLen(word), _MIN_IPA_LENGTH)) {
    return null;
  }
  return (
    `\\{"word": ${pyJsonDumps(word, { ensureAscii: false })}, ` +
    `"pronounce": ${pyJsonDumps(formatted, { ensureAscii: false })}\\}`
  );
}

export interface DeepgramTTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Deepgram API key for authentication. */
  apiKey: string;
  /** WebSocket base URL for Deepgram API. Defaults to "wss://api.deepgram.com". */
  baseUrl?: string;
  /** Audio encoding format. Defaults to "linear16". Must be one of SUPPORTED_ENCODINGS. */
  encoding?: string;
  /**
   * Opt out of the Deepgram Model Improvement Program. See
   * https://dpgr.am/deepgram-mip for pricing impacts before setting to true.
   */
  mipOptOut?: boolean | null;
  /** Runtime-updatable settings. */
  settings?: DeepgramTTSSettings | null;
  /**
   * Creates the underlying `WebSocket`, to open it some other way (through a
   * proxy, say). Defaults to `websocketConnect`'s, which sends the header on
   * every runtime, Cloudflare Workers included. Not in upstream.
   */
  webSocketFactory?: WebsocketConnectOptions["webSocketFactory"];
}

/**
 * Deepgram WebSocket-based text-to-speech service.
 *
 * Provides real-time text-to-speech synthesis using Deepgram's WebSocket API.
 * Supports streaming audio generation with interruption handling via the
 * Clear message for conversational AI use cases.
 */
export class DeepgramTTSService extends WebsocketTTSService {
  static Settings: typeof DeepgramTTSSettings = DeepgramTTSSettings;
  declare protected _settings: DeepgramTTSSettings;

  static readonly SUPPORTED_ENCODINGS: readonly string[] = ["linear16", "mulaw", "alaw"];

  static {
    installTracedTts(DeepgramTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _encoding: string;
  protected _mipOptOut: boolean | null;
  protected _webSocketFactory: WebsocketConnectOptions["webSocketFactory"];
  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Deepgram WebSocket TTS service.
   *
   * @param options.apiKey Deepgram API key for authentication.
   * @param options.baseUrl WebSocket base URL for Deepgram API. Defaults to
   *   "wss://api.deepgram.com".
   * @param options.sampleRate Audio sample rate in Hz. If null, uses service
   *   default.
   * @param options.encoding Audio encoding format. Defaults to "linear16".
   *   Must be one of SUPPORTED_ENCODINGS.
   * @param options.mipOptOut Opt out of the Deepgram Model Improvement
   *   Program. See https://dpgr.am/deepgram-mip for pricing impacts before
   *   setting to true.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent WebsocketTTSService.
   * @throws Error (ValueError) if encoding is not in SUPPORTED_ENCODINGS.
   */
  constructor(options: DeepgramTTSServiceOptions) {
    const encoding = options.encoding ?? "linear16";
    const cls = new.target as typeof DeepgramTTSService;
    if (!cls.SUPPORTED_ENCODINGS.includes(encoding.toLowerCase())) {
      throw new Error(
        `Unsupported encoding '${encoding}'. Must be one of ${cls.SUPPORTED_ENCODINGS.join(", ")} for WebSocket TTS.`,
      );
    }

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: null,
      voice: "aura-2-helena-en",
      language: null,
      speed: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      pauseFrameProcessing: true,
      pushStopFrames: false,
      pushStartFrame: true,
      appendTrailingSpace: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "wss://api.deepgram.com";
    this._encoding = encoding;
    this._mipOptOut = options.mipOptOut ?? null;
    this._webSocketFactory = options.webSocketFactory ?? null;
  }

  /**
   * Render a pronunciation as a Deepgram inline pronunciation object.
   *
   * See `formatDeepgramPronunciation`.
   *
   * @param word The word being pronounced.
   * @param ipa The pronunciation, in IPA.
   * @returns The inline object, or null when the pronunciation cannot be used.
   */
  static override formatPronunciation(word: string, ipa: string): string | null {
    return formatDeepgramPronunciation(word, ipa);
  }

  /**
   * Check if the service can generate metrics.
   *
   * @returns True, as Deepgram WebSocket TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._connect();
  }

  /** Connect to Deepgram WebSocket and start receive task. */
  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /** Disconnect from Deepgram WebSocket and clean up tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /**
   * Apply a settings delta.
   *
   * @param delta A TTSSettings (or `DeepgramTTSService.Settings`) delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    // Deepgram uses voice as the model, so keep them in sync for metrics
    if ("voice" in changed) {
      this._settings.model = this._settings.voice as string | null;
      this._syncModelNameToMetrics();
    }

    if (Object.keys(changed).length > 0) {
      await this._disconnect();
      await this._connect();
    }

    return changed;
  }

  /** Connect to Deepgram WebSocket API with configured settings. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Deepgram WebSocket");

      // Build WebSocket URL with query parameters
      const params: string[] = [];
      params.push(`model=${this._settings.voice}`);
      params.push(`encoding=${this._encoding}`);
      params.push(`sample_rate=${this.sampleRate}`);
      if (this._settings.speed !== null) {
        params.push(`speed=${this._settings.speed}`);
      }
      if (this._mipOptOut !== null) {
        params.push(`mip_opt_out=${String(this._mipOptOut)}`);
      }

      const url = `${this._baseUrl}/v1/speak?${params.join("&")}`;

      const headers = { Authorization: `Token ${this._apiKey}` };

      this._websocket = await this._websocketConnect(url, {
        additionalHeaders: headers,
        webSocketFactory: this._webSocketFactory,
      });

      logger.debug(`${this}: Websocket connection initialized`);

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception: ${errorMessage(e)}`);
      await this.pushErrorFrame(
        new ErrorFrame({ error: `${this} error: ${errorMessage(e)}`, exception: e }),
      );
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  /** Close WebSocket connection and reset state. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug(`${this}: Disconnecting from Deepgram WebSocket`);
        // Send Close message to gracefully close the connection
        await this._websocket.send(pyJsonDumps({ type: "Close" }));
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception: ${errorMessage(e)}`);
      await this.pushErrorFrame(new ErrorFrame({ error: `${this} error: ${errorMessage(e)}` }));
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /** Get active websocket connection or raise exception. */
  protected _getWebsocket() {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /**
   * Send Clear message to Deepgram when an audio context is interrupted.
   *
   * The Clear message will clear Deepgram's internal text buffer and stop
   * sending audio, allowing for a new response to be generated.
   *
   * @param contextId The ID of the audio context that was interrupted.
   */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    if (this._websocket) {
      try {
        await this._websocket.send(pyJsonDumps({ type: "Clear" }));
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} error sending Clear message: ${errorMessage(e)}`);
      }
    }
    await super.onAudioContextInterrupted(contextId);
  }

  /** Receive and process messages from Deepgram WebSocket. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      if (message instanceof Uint8Array) {
        // Binary message contains audio data
        const ctxId = this.getActiveAudioContextId();
        const frame = new TTSAudioRawFrame({
          audio: message,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId: ctxId,
        });
        await this.appendToAudioContext(ctxId, frame);
      } else if (typeof message === "string") {
        // Text message contains metadata or control messages
        let msg: Dict;
        try {
          msg = pyJsonLoads(message) as Dict;
        } catch (e) {
          rethrowIfCancelled(e);
          if (e instanceof SyntaxError) {
            logger.error(`Invalid JSON message: ${message}`);
            continue;
          }
          throw e;
        }
        const msgType = msg?.type;

        if (msgType === "Metadata") {
          logger.trace(`Received metadata: ${pyJsonDumps(msg)}`);
        } else if (msgType === "Flushed") {
          logger.trace(`Received Flushed: ${pyJsonDumps(msg)}`);
          const ctxId = this.getActiveAudioContextId();
          await this.appendToAudioContext(ctxId, new TTSStoppedFrame({ contextId: ctxId }));
          await this.removeAudioContext(ctxId);
        } else if (msgType === "Cleared") {
          logger.trace(`Received Cleared: ${pyJsonDumps(msg)}`);
          // Buffer has been cleared after interruption.
          // The onAudioContextInterrupted handler already cleaned up.
        } else if (msgType === "Warning") {
          const description = msg.warn_msg || msg.description;
          logger.warning(`${this} warning: ${description || "Unknown warning"}`);
        } else {
          logger.debug(`Received unknown message type: ${pyJsonDumps(msg)}`);
        }
      }
    }
  }

  /**
   * Flush any pending audio synthesis by sending Flush command.
   *
   * This should be called when the LLM finishes a complete response to force
   * generation of audio from Deepgram's internal text buffer.
   */
  override async flushAudio(_contextId: string | null = null): Promise<void> {
    if (this._websocket) {
      try {
        const flushMsg = { type: "Flush" };
        await this._websocket.send(pyJsonDumps(flushMsg));
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} error sending Flush message: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * Generate speech from text using Deepgram's WebSocket TTS API.
   *
   * @param text The text to synthesize into speech.
   * @param _contextId The context ID for tracking audio frames.
   * @returns Audio frames are delivered by the receive task; yields null, or
   *   an ErrorFrame on failure.
   */
  override async *runTts(text: string, _contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      // Reconnect if the websocket is closed
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      // Send text message to Deepgram
      // Note: We don't send Flush here - that should only be sent when the
      // LLM finishes a complete response via flushAudio()
      const speakMsg = { type: "Speak", text };
      await this._getWebsocket().send(pyJsonDumps(speakMsg));
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
      return;
    }

    // The audio frames will be handled in _receiveMessages
    yield null;
  }
}

/**
 * Yield a body stream's bytes as they arrive, in chunks of at most
 * `chunkSize` bytes (aiohttp's `iter_chunked`).
 */
async function* iterChunked(
  body: ReadableStream<Uint8Array> | null,
  chunkSize: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (!value || value.length === 0) continue;
      for (let offset = 0; offset < value.length; offset += chunkSize) {
        yield value.subarray(offset, Math.min(offset + chunkSize, value.length));
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}

export interface DeepgramHttpTTSServiceOptions extends TTSServiceOptions {
  /** Deepgram API key for authentication. */
  apiKey: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream requires a shared `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Custom base URL for Deepgram API. Defaults to "https://api.deepgram.com". */
  baseUrl?: string;
  /** Audio encoding format. Defaults to "linear16". */
  encoding?: string;
  /**
   * Opt out of the Deepgram Model Improvement Program. See
   * https://dpgr.am/deepgram-mip for pricing impacts before setting to true.
   */
  mipOptOut?: boolean | null;
  /** Runtime-updatable settings. */
  settings?: DeepgramTTSSettings | null;
}

/**
 * Deepgram HTTP text-to-speech service.
 *
 * Provides text-to-speech synthesis using Deepgram's HTTP TTS API. Supports
 * various voice models and audio encoding formats with configurable sample
 * rates and quality settings.
 */
export class DeepgramHttpTTSService extends TTSService {
  static Settings: typeof DeepgramTTSSettings = DeepgramTTSSettings;
  declare protected _settings: DeepgramTTSSettings;

  static {
    installTracedTts(DeepgramHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _fetch: typeof fetch;
  protected _baseUrl: string;
  protected _encoding: string;
  protected _mipOptOut: boolean | null;

  /**
   * Initialize the Deepgram TTS service.
   *
   * @param options.apiKey Deepgram API key for authentication.
   * @param options.fetch `fetch` used for HTTP requests (upstream: a shared
   *   aiohttp session). Defaults to the global `fetch`.
   * @param options.baseUrl Custom base URL for Deepgram API. Defaults to
   *   "https://api.deepgram.com".
   * @param options.sampleRate Audio sample rate in Hz. If null, uses service
   *   default.
   * @param options.encoding Audio encoding format. Defaults to "linear16".
   * @param options.mipOptOut Opt out of the Deepgram Model Improvement
   *   Program. See https://dpgr.am/deepgram-mip for pricing impacts before
   *   setting to true.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: DeepgramHttpTTSServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof DeepgramHttpTTSService).Settings({
      model: null,
      voice: "aura-2-helena-en",
      language: null,
      speed: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this._baseUrl = options.baseUrl ?? "https://api.deepgram.com";
    this._encoding = options.encoding ?? "linear16";
    this._mipOptOut = options.mipOptOut ?? null;
  }

  /**
   * Render a pronunciation as a Deepgram inline pronunciation object.
   *
   * See `formatDeepgramPronunciation`.
   *
   * @param word The word being pronounced.
   * @param ipa The pronunciation, in IPA.
   * @returns The inline object, or null when the pronunciation cannot be used.
   */
  static override formatPronunciation(word: string, ipa: string): string | null {
    return formatDeepgramPronunciation(word, ipa);
  }

  /**
   * Check if the service can generate metrics.
   *
   * @returns True, as Deepgram TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Generate speech from text using Deepgram's TTS API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech, plus start/stop
   *   frames.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    // Build URL with parameters
    const url = `${this._baseUrl}/v1/speak`;

    const headers = {
      Authorization: `Token ${this._apiKey}`,
      "Content-Type": "application/json",
    };

    const params = new URLSearchParams();
    params.append("model", String(this._settings.voice));
    params.append("encoding", this._encoding);
    params.append("sample_rate", String(this.sampleRate));
    params.append("container", "none");

    if (this._settings.speed !== null) {
      params.append("speed", String(this._settings.speed));
    }

    if (this._mipOptOut !== null) {
      params.append("mip_opt_out", String(this._mipOptOut));
    }

    const payload = {
      text,
    };

    try {
      await this.startTtfbMetrics();

      const response = await abortable(
        this._fetch(`${url}?${params.toString()}`, {
          method: "POST",
          headers,
          body: pyJsonDumps(payload),
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        const errorText = await abortable(response.text());
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      await this.startTtsUsageMetrics(text);

      // HTTP chunk boundaries can fall mid-sample, so let the iterator helper
      // keep emitted frames sample-aligned.
      for await (const frame of this._streamAudioFramesFromIterator(
        iterChunked(response.body, this.chunkSize),
        { contextId },
      )) {
        await this.stopTtfbMetrics();
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Error getting audio: ${errorMessage(e)}` });
    }
  }
}
