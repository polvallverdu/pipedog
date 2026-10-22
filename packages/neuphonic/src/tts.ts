// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/neuphonic/tts.py

/**
 * Neuphonic text-to-speech service implementations.
 *
 * This module provides WebSocket and HTTP-based integrations with Neuphonic's
 * text-to-speech API for real-time audio synthesis.
 *
 * Porting notes:
 * - Upstream talks to Neuphonic's API directly (`websockets` and `aiohttp`, not the
 *   `pyneuphonic` SDK), so this port does too: core's `websocketConnect` and `fetch`.
 *   The `x-api-key` header goes on the opening handshake, which works on Workers too.
 * - `NeuphonicHttpTTSService` takes an optional `fetch` where upstream takes a required
 *   shared `aiohttp_session`.
 * - Float query values are written the way Python writes them (`speed=1.0`, not `1`).
 * - Not ported, as deprecated upstream: `InputParams`, and the `params`, `voice_id` and
 *   `aggregate_sentences` constructor arguments. Use `settings` and `textAggregationMode`.
 */

import {
  abortable,
  CancelledError,
  currentSignal,
  rethrowIfCancelled,
  type Task,
} from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import {
  InterruptibleTTSService,
  type InterruptibleTTSServiceOptions,
  TTSService,
  type TTSServiceOptions,
} from "@pipedog/core/services/tts_service";
import { State } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `str(float)` for the values a query string carries (`1.0`, not `1`). */
function pyFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/**
 * Convert a Language enum to Neuphonic language code.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g.,
 *   `en` from `en-US`) and logs a warning (via `resolveLanguage(..., true)`).
 */
export function languageToNeuphonicLangCode(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.DE]: "de",
    [Language.EN]: "en",
    [Language.ES]: "es",
    [Language.NL]: "nl",
    [Language.AR]: "ar",
    [Language.FR]: "fr",
    [Language.PT]: "pt",
    [Language.RU]: "ru",
    [Language.HI]: "hi",
    [Language.ZH]: "zh",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface NeuphonicTTSSettingsOptions extends TTSSettingsOptions {
  /** Speech speed multiplier. Defaults to 1.0. */
  speed?: number | NotGiven;
  /**
   * Randomness introduced into the synthesis, from 0.0 to 1.0. Left to Neuphonic's own
   * default when unset.
   */
  temperature?: number | null | NotGiven;
  /**
   * Regional variant whose sounds `<phoneme:...>` tags in the text are read with, either
   * `es-castilian` or `pt-br`. Left to Neuphonic's own default when unset.
   */
  ipaKey?: string | null | NotGiven;
}

/**
 * Settings for NeuphonicTTSService and NeuphonicHttpTTSService.
 *
 * - `speed`: speech speed multiplier. Defaults to 1.0.
 * - `temperature`: randomness introduced into the synthesis, from 0.0 to 1.0.
 *   Left to Neuphonic's own default when unset.
 * - `ipaKey`: regional variant whose sounds `<phoneme:...>` tags in the text are
 *   read with, either `es-castilian` or `pt-br`. Left to Neuphonic's own default
 *   when unset.
 */
export class NeuphonicTTSSettings extends TTSSettings {
  speed: number | NotGiven = NOT_GIVEN;
  temperature: number | null | NotGiven = NOT_GIVEN;
  ipaKey: string | null | NotGiven = NOT_GIVEN;

  constructor(options: NeuphonicTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

function defaultNeuphonicSettings(cls: typeof NeuphonicTTSSettings): NeuphonicTTSSettings {
  return new cls({
    model: null,
    voice: null,
    language: Language.EN,
    speed: 1.0,
    temperature: null,
    ipaKey: null,
  });
}

export interface NeuphonicTTSServiceOptions extends InterruptibleTTSServiceOptions {
  /** Neuphonic API key for authentication. */
  apiKey: string;
  /** WebSocket URL for the Neuphonic API. */
  url?: string;
  /** Audio encoding format. Defaults to "pcm_linear". */
  encoding?: string;
  /** Runtime-updatable settings. */
  settings?: NeuphonicTTSSettings | null;
}

/**
 * Neuphonic real-time text-to-speech service using WebSocket streaming.
 *
 * Provides real-time text-to-speech synthesis using Neuphonic's WebSocket API.
 * Supports interruption handling, keepalive connections, and configurable voice
 * parameters for high-quality speech generation.
 */
export class NeuphonicTTSService extends InterruptibleTTSService {
  static Settings: typeof NeuphonicTTSSettings = NeuphonicTTSSettings;
  declare protected _settings: NeuphonicTTSSettings;

  static {
    installTracedTts(NeuphonicTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _receiveTask: Task<unknown> | null = null;
  protected _encoding: string;
  protected _samplingRate: number | null;

  /**
   * Initialize the Neuphonic TTS service.
   *
   * @param options.apiKey Neuphonic API key for authentication.
   * @param options.url WebSocket URL for the Neuphonic API.
   * @param options.sampleRate Audio sample rate in Hz. Defaults to 22050.
   * @param options.encoding Audio encoding format. Defaults to "pcm_linear".
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate text before synthesis.
   *   Other options are passed to the parent InterruptibleTTSService.
   */
  constructor(options: NeuphonicTTSServiceOptions) {
    const defaultSettings = defaultNeuphonicSettings(
      (new.target as typeof NeuphonicTTSService).Settings,
    );

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const sampleRate = options.sampleRate === undefined ? 22050 : options.sampleRate;

    super({
      ...options,
      pushStopFrames: true,
      pushStartFrame: true,
      pauseFrameProcessing: true,
      sampleRate,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://api.neuphonic.com";
    this._encoding = options.encoding ?? "pcm_linear";
    this._samplingRate = sampleRate;
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Neuphonic service language format.
   *
   * @param language The language to convert.
   * @returns The Neuphonic-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToNeuphonicLangCode(language);
  }

  /** Apply a settings delta and reconnect with new configuration. */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length > 0) {
      await this._disconnect();
      await this._connect();
      logger.info(`Switching TTS to settings: [${this._settings}]`);
    }
    return changed;
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

  /** Flush any pending audio synthesis by sending stop command. */
  override async flushAudio(_contextId: string | null = null): Promise<void> {
    if (this._websocket) {
      const msg = { text: "<STOP>" };
      await this._websocket.send(pyJsonDumps(msg));
    }
  }

  /** Connect to Neuphonic WebSocket and start background tasks. */
  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }

    if (this._websocket) {
      this._createKeepaliveTask(10);
    }
  }

  /** Disconnect from Neuphonic WebSocket and clean up tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._cancelKeepaliveTask();

    await this._disconnectWebsocket();
  }

  /** The WebSocket URL for the current settings. */
  protected _buildUrl(): string {
    const ttsConfig: [string, string | null][] = [
      ["lang_code", this._settings.language === null ? null : String(this._settings.language)],
      ["speed", this._settings.speed === null ? null : pyFloat(assertGiven(this._settings.speed))],
      [
        "temperature",
        this._settings.temperature === null
          ? null
          : pyFloat(assertGiven(this._settings.temperature) as number),
      ],
      ["encoding", this._encoding],
      ["sampling_rate", this._samplingRate === null ? null : String(this._samplingRate)],
      ["voice_id", this._settings.voice === null ? null : String(this._settings.voice)],
      ["ipa_key", this._settings.ipaKey === null ? null : String(this._settings.ipaKey)],
    ];

    const queryParams: string[] = [];
    for (const [key, value] of ttsConfig) {
      if (value !== null) {
        queryParams.push(`${key}=${value}`);
      }
    }

    let url = `${this._url}/speak/${this._settings.language}`;
    if (queryParams.length > 0) {
      url += `?${queryParams.join("&")}`;
    }
    return url;
  }

  /** Establish WebSocket connection to Neuphonic API. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to Neuphonic");

      const url = this._buildUrl();
      const headers = { "x-api-key": this._apiKey };

      this._websocket = await this._websocketConnect(url, { additionalHeaders: headers });

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  /** Close WebSocket connection and clean up state. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug("Disconnecting from Neuphonic");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /** Receive and process messages from Neuphonic WebSocket. */
  override async _receiveMessages(): Promise<void> {
    const websocket = this._websocket;
    if (websocket === null) {
      return;
    }
    for await (const message of websocket) {
      if (typeof message === "string") {
        const msg = pyJsonLoads(message) as Dict;
        if (msg.data?.audio) {
          await this.stopTtfbMetrics();

          const audio = base64ToBytes(msg.data.audio);
          const contextId = this.getActiveAudioContextId();
          const frame = new TTSAudioRawFrame({
            audio,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId,
          });
          await this.appendToAudioContext(contextId, frame);
        }
      }
    }
  }

  /** Send empty text to keep the connection open through silences. */
  protected override async _sendKeepalive(): Promise<void> {
    if (this._websocket) {
      await this._websocket.send(pyJsonDumps({ text: "" }));
    }
  }

  /** Send text to Neuphonic WebSocket for synthesis. */
  protected async _sendText(text: string): Promise<void> {
    if (this._websocket) {
      const msg = { text: `${text} <STOP>` };
      logger.debug(`Sending text to websocket: ${pyJsonDumps(msg)}`);
      await this._websocket.send(pyJsonDumps(msg));
    }
  }

  /**
   * Generate speech from text using Neuphonic's streaming API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId Unique identifier for this TTS context.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      let failure: unknown = null;
      try {
        await this._sendText(text);
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        failure = e;
      }
      if (failure !== null) {
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(failure)}` });
        yield new TTSStoppedFrame({ contextId });
        await this._disconnect();
        await this._connect();
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}

/** Yield a response body's lines, newline included (aiohttp's `async for line in response.content`). */
async function* iterLines(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (!value || value.length === 0) continue;
      const joined = new Uint8Array(pending.length + value.length);
      joined.set(pending);
      joined.set(value, pending.length);
      let from = 0;
      let newline = joined.indexOf(0x0a, from);
      while (newline !== -1) {
        yield joined.subarray(from, newline + 1);
        from = newline + 1;
        newline = joined.indexOf(0x0a, from);
      }
      pending = joined.slice(from);
    }
    if (pending.length > 0) {
      yield pending;
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}

export interface NeuphonicHttpTTSServiceOptions extends TTSServiceOptions {
  /** Neuphonic API key for authentication. */
  apiKey: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream takes a required shared `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Base URL for the Neuphonic HTTP API. */
  url?: string;
  /** Audio encoding format. Defaults to "pcm_linear". */
  encoding?: string | null;
  /** Runtime-updatable settings. */
  settings?: NeuphonicTTSSettings | null;
}

/**
 * Neuphonic text-to-speech service using HTTP streaming.
 *
 * Provides text-to-speech synthesis using Neuphonic's HTTP API with server-sent
 * events for streaming audio delivery. Suitable for applications that prefer
 * HTTP-based communication over WebSocket connections.
 */
export class NeuphonicHttpTTSService extends TTSService {
  static Settings: typeof NeuphonicTTSSettings = NeuphonicTTSSettings;
  declare protected _settings: NeuphonicTTSSettings;

  static {
    installTracedTts(NeuphonicHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _fetch: typeof fetch;
  protected _baseUrl: string;
  protected _encoding: string | null;

  /**
   * Initialize the Neuphonic HTTP TTS service.
   *
   * @param options.apiKey Neuphonic API key for authentication.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an aiohttp session).
   * @param options.url Base URL for the Neuphonic HTTP API.
   * @param options.sampleRate Audio sample rate in Hz. Defaults to 22050.
   * @param options.encoding Audio encoding format. Defaults to "pcm_linear".
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: NeuphonicHttpTTSServiceOptions) {
    const defaultSettings = defaultNeuphonicSettings(
      (new.target as typeof NeuphonicHttpTTSService).Settings,
    );

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate === undefined ? 22050 : options.sampleRate,
      pushStopFrames: true,
      pushStartFrame: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this._baseUrl = (options.url ?? "https://api.neuphonic.com").replace(/\/+$/, "");
    this._encoding = options.encoding === undefined ? "pcm_linear" : options.encoding;
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Neuphonic service language format.
   *
   * @param language The language to convert.
   * @returns The Neuphonic-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToNeuphonicLangCode(language);
  }

  /**
   * Flush any pending audio synthesis.
   *
   * HTTP-based service doesn't require explicit flushing.
   */
  override async flushAudio(_contextId: string | null = null): Promise<void> {}

  /**
   * Parse a Server-Sent Event message.
   *
   * @param message The SSE message to parse.
   * @returns Parsed message dictionary or null if not a data message.
   */
  protected _parseSseMessage(message: string): Dict | null {
    message = message.trim();

    if (!message?.includes("data")) {
      return null;
    }

    // Split on ": " and take the part after "data: "
    const split = message.indexOf(": ");
    if (split === -1) {
      logger.warning("Failed to parse SSE message: not enough values to unpack");
      return null;
    }
    const dataContent = message.slice(split + 2);

    if (!dataContent || dataContent === "[DONE]") {
      return null;
    }

    let messageDict: Dict;
    try {
      messageDict = pyJsonLoads(dataContent) as Dict;
    } catch (e) {
      rethrowIfCancelled(e);
      if (e instanceof SyntaxError) {
        logger.warning(`Failed to parse SSE message: ${e.message}`);
        return null;
      }
      throw e;
    }

    // Check for errors in the response
    if (messageDict.errors !== undefined && messageDict.errors !== null) {
      throw new Error(
        `Neuphonic API error ${messageDict.status_code ?? "unknown"}: ${pyJsonDumps(messageDict.errors)}`,
      );
    }

    return messageDict;
  }

  /**
   * Generate speech from text using Neuphonic streaming API.
   *
   * @param text The text to convert to speech.
   * @param contextId Unique identifier for this TTS context.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const url = `${this._baseUrl}/sse/speak/${this._settings.language}`;

    const headers = {
      "X-API-KEY": this._apiKey,
      "Content-Type": "application/json",
    };

    const payload: Dict = {
      text,
      lang_code: this._settings.language,
      encoding: this._encoding,
      sampling_rate: this.sampleRate,
      speed: this._settings.speed,
    };

    if (this._settings.voice) {
      payload.voice_id = this._settings.voice;
    }

    if (this._settings.temperature !== null) {
      payload.temperature = this._settings.temperature;
    }

    if (this._settings.ipaKey !== null) {
      payload.ipa_key = this._settings.ipaKey;
    }

    try {
      const response = await abortable(
        this._fetch(url, {
          method: "POST",
          headers,
          body: pyJsonDumps(payload),
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        const errorText = await abortable(response.text());
        const errorMessageText = `Neuphonic API error: HTTP ${response.status} - ${errorText}`;
        yield new ErrorFrame({ error: errorMessageText });
        return;
      }

      await this.startTtsUsageMetrics(text);

      // Process SSE stream line by line
      const decoder = new TextDecoder("utf-8");
      for await (const line of iterLines(response.body)) {
        if (line.length === 0) {
          continue;
        }

        const message = decoder.decode(line);
        if (!message.trim()) {
          continue;
        }

        try {
          const parsedMessage = this._parseSseMessage(message);

          if (parsedMessage !== null && parsedMessage.data?.audio != null) {
            const audioB64 = parsedMessage.data.audio;
            const audioBytes = base64ToBytes(audioB64);

            await this.stopTtfbMetrics();
            yield new TTSAudioRawFrame({
              audio: audioBytes,
              sampleRate: this.sampleRate,
              numChannels: 1,
              contextId,
            });
          }
        } catch (e) {
          rethrowIfCancelled(e);
          yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
          // Don't yield error frame for individual message failures
        }
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        logger.debug("TTS generation cancelled");
        throw e;
      }
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}
