// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/xai/tts.py

/**
 * xAI text-to-speech service implementation.
 *
 * Provides two TTS services against xAI's voice API:
 *
 * - `XAIHttpTTSService` uses the batch HTTP endpoint at
 *   `https://api.x.ai/v1/tts`.
 * - `XAITTSService` uses the streaming WebSocket endpoint at
 *   `wss://api.x.ai/v1/tts`.
 *
 * See https://docs.x.ai/developers/rest-api-reference/inference/voice.
 *
 * Porting notes:
 * - `XAIHttpTTSService` uses `fetch`. Upstream's optional `aiohttp_session`
 *   becomes an optional `fetch` function (defaults to the global `fetch`), so
 *   there is no session to open or close.
 * - `XAITTSService` connects through `WebsocketService._websocketConnect()`
 *   (the core `websocketConnect`), with the `Authorization: Bearer` header on
 *   the opening handshake.
 * - Query values are written with `URLSearchParams` and JS number formatting,
 *   so a float with an integral value (`speed=1.0` upstream) is written
 *   `speed=1`.
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
import { State } from "@pipedog/core/services/websocket_service";
import { isLanguage, Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Convert a Language enum to xAI language code.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g., `en`
 *   from `en-US`) and logs a warning.
 */
export function languageToXaiLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AR]: "ar-EG",
    [Language.AR_EG]: "ar-EG",
    [Language.AR_SA]: "ar-SA",
    [Language.AR_AE]: "ar-AE",
    [Language.BN]: "bn",
    [Language.DE]: "de",
    [Language.EN]: "en",
    [Language.ES]: "es-ES",
    [Language.ES_ES]: "es-ES",
    [Language.ES_MX]: "es-MX",
    [Language.FR]: "fr",
    [Language.HI]: "hi",
    [Language.ID]: "id",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.KO]: "ko",
    [Language.PT]: "pt-PT",
    [Language.PT_BR]: "pt-BR",
    [Language.PT_PT]: "pt-PT",
    [Language.RU]: "ru",
    [Language.TR]: "tr",
    [Language.VI]: "vi",
    [Language.ZH]: "zh",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/**
 * Convert xAI character timings into `[word, startTime]` pairs.
 *
 * When `with_timestamps` is enabled, each xAI `audio.delta` carries
 * per-character `graph_chars` (including spaces and punctuation) and
 * `graph_times` as `[start, end]` second pairs. The times are absolute from
 * the start of the utterance and continue across chunks, so they are used
 * as-is. Words are split on spaces, each assigned the start time of its first
 * character, and a word that straddles a chunk boundary is carried over via
 * `partialWord`.
 *
 * @returns `[wordTimes, partialWord, partialWordStartTime]` where the latter
 *   two describe an unterminated trailing word for the next chunk to finish.
 */
export function _xaiWordTimes(
  graphChars: string[],
  graphTimes: number[][],
  partialWord = "",
  partialWordStartTime = 0.0,
): [[string, number][], string, number] {
  if (graphChars.length !== graphTimes.length) {
    logger.error(
      `xAI timestamp length mismatch: chars=${graphChars.length}, times=${graphTimes.length}`,
    );
    return [[], partialWord, partialWordStartTime];
  }

  const words: [string, number][] = [];
  let currentWord = partialWord;
  let wordStartTime: number | null = partialWord ? partialWordStartTime : null;

  for (let i = 0; i < graphChars.length; i++) {
    const char = graphChars[i]!;
    const times = graphTimes[i]!;
    if (char === " ") {
      if (currentWord) {
        words.push([currentWord, wordStartTime || 0.0]);
        currentWord = "";
        wordStartTime = null;
      }
    } else {
      if (wordStartTime === null) {
        wordStartTime = times[0]!;
      }
      currentWord += char;
    }
  }

  return [words, currentWord, wordStartTime !== null ? wordStartTime : 0.0];
}

/** `str(language)` of a settings language value. */
function languageString(language: unknown): string {
  return String(language);
}

export interface XAITTSSettingsOptions extends TTSSettingsOptions {
  /** Speech speed multiplier from 0.7 to 1.5 (1.0 is normal). */
  speed?: number | null | NotGiven;
  /** Latency optimization level (0, 1, or 2). */
  optimizeStreamingLatency?: number | null | NotGiven;
  /** Whether to normalize text before synthesis. */
  textNormalization?: boolean | null | NotGiven;
}

/**
 * Settings for XAIHttpTTSService.
 *
 * - `speed`: speech speed multiplier from 0.7 to 1.5 (1.0 is normal).
 * - `optimizeStreamingLatency`: latency optimization level (0, 1, or 2).
 * - `textNormalization`: whether to normalize text before synthesis.
 */
export class XAITTSSettings extends TTSSettings {
  speed: number | null | NotGiven = NOT_GIVEN;
  optimizeStreamingLatency: number | null | NotGiven = NOT_GIVEN;
  textNormalization: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: XAITTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
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

export interface XAIHttpTTSServiceOptions extends TTSServiceOptions {
  /** xAI API key for authentication. */
  apiKey: string;
  /** xAI TTS endpoint. Defaults to "https://api.x.ai/v1/tts". */
  baseUrl?: string;
  /** Output encoding format. Defaults to "pcm". */
  encoding?: string | null;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream takes an optional shared `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Runtime-updatable settings. */
  settings?: XAITTSSettings | null;
}

/**
 * xAI HTTP text-to-speech service.
 *
 * The service requests raw PCM audio so emitted `TTSAudioRawFrame` objects
 * match Pipecat's downstream expectations without extra decoding.
 */
export class XAIHttpTTSService extends TTSService {
  static Settings: typeof XAITTSSettings = XAITTSSettings;
  declare protected _settings: XAITTSSettings;

  static {
    installTracedTts(XAIHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _fetch: typeof fetch;
  protected _encoding: string | null;

  /**
   * Initialize the xAI TTS service.
   *
   * @param options.apiKey xAI API key for authentication.
   * @param options.baseUrl xAI TTS endpoint. Defaults to
   *   "https://api.x.ai/v1/tts".
   * @param options.sampleRate Audio sample rate. If null, uses default.
   * @param options.encoding Output encoding format. Defaults to "pcm".
   * @param options.fetch `fetch` used for HTTP requests (upstream: an
   *   optional shared aiohttp session).
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to `TTSService`.
   */
  constructor(options: XAIHttpTTSServiceOptions) {
    const defaultSettings = new (new.target as typeof XAIHttpTTSService).Settings({
      model: null,
      voice: "eve",
      language: Language.EN,
      speed: null,
      optimizeStreamingLatency: null,
      textNormalization: null,
    });

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
    this._baseUrl = options.baseUrl ?? "https://api.x.ai/v1/tts";
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this._encoding = options.encoding === undefined ? "pcm" : options.encoding;
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to xAI language format.
   *
   * @param language The language to convert.
   * @returns The xAI-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToXaiLanguage(language);
  }

  /** Generate speech from text using xAI's TTS API. */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const payload: Dict = {
      text,
      voice_id: this._settings.voice,
      output_format: {
        codec: this._encoding,
        sample_rate: this.sampleRate,
      },
    };
    payload.language = this._settings.language ? languageString(this._settings.language) : "auto";

    if (assertGiven(this._settings.speed) !== null) {
      payload.speed = this._settings.speed;
    }
    if (assertGiven(this._settings.optimizeStreamingLatency) !== null) {
      payload.optimize_streaming_latency = this._settings.optimizeStreamingLatency;
    }
    if (assertGiven(this._settings.textNormalization) !== null) {
      payload.text_normalization = this._settings.textNormalization;
    }

    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      "Content-Type": "application/json",
    };

    try {
      const response = await abortable(
        this._fetch(this._baseUrl, {
          method: "POST",
          headers,
          body: pyJsonDumps(payload),
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        const error = await abortable(response.text());
        yield new ErrorFrame({
          error: `Error getting audio (status: ${response.status}, error: ${error})`,
        });
        return;
      }

      await this.startTtsUsageMetrics(text);

      // xAI chops the stream at arbitrary byte boundaries, so let the
      // iterator helper keep emitted frames sample-aligned.
      for await (const frame of this._streamAudioFramesFromIterator(
        iterChunked(response.body, this.chunkSize),
        { contextId },
      )) {
        await this.stopTtfbMetrics();
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}

export interface XAIWebsocketTTSSettingsOptions extends XAITTSSettingsOptions {
  /**
   * Whether to request character timings. When enabled, the service converts
   * them into per-word `TTSTextFrame` objects.
   */
  withTimestamps?: boolean | null | NotGiven;
}

/**
 * Settings for XAITTSService (WebSocket streaming).
 *
 * - `speed`: speech speed multiplier from 0.7 to 1.5 (1.0 is normal).
 * - `optimizeStreamingLatency`: latency optimization level (0, 1, or 2).
 * - `textNormalization`: whether to normalize text before synthesis.
 * - `withTimestamps`: whether to request character timings. When enabled,
 *   the service converts them into per-word `TTSTextFrame` objects.
 */
export class XAIWebsocketTTSSettings extends TTSSettings {
  speed: number | null | NotGiven = NOT_GIVEN;
  optimizeStreamingLatency: number | null | NotGiven = NOT_GIVEN;
  textNormalization: boolean | null | NotGiven = NOT_GIVEN;
  withTimestamps: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: XAIWebsocketTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface XAITTSServiceOptions extends WebsocketTTSServiceOptions {
  /** xAI API key for authentication. */
  apiKey: string;
  /** xAI TTS WebSocket endpoint. Defaults to "wss://api.x.ai/v1/tts". */
  baseUrl?: string;
  /**
   * Output audio codec. One of `pcm`, `wav`, `mulaw`, `alaw`. Defaults to
   * `pcm` so emitted `TTSAudioRawFrame` objects need no decoding downstream.
   */
  codec?: string;
  /** Runtime-updatable settings. */
  settings?: XAIWebsocketTTSSettings | null;
}

/**
 * xAI streaming text-to-speech service.
 *
 * Connects to xAI's WebSocket TTS endpoint and streams audio chunks back as
 * they are synthesized. Text can be sent incrementally via `text.delta`
 * messages and each utterance is terminated with `text.done`. The server
 * responds with `audio.delta` chunks followed by an `audio.done` message.
 *
 * Audio parameters (voice, language, codec, sample rate) are passed as query
 * string parameters on the WebSocket URL; changing any of them at runtime
 * reconnects the WebSocket. With `withTimestamps` enabled, xAI's
 * per-character timings are converted into per-word `TTSTextFrame` objects.
 *
 * Note that xAI delivers timestamps in batches that are decoupled from the
 * audio stream (a batch can cover several seconds of speech and arrive in one
 * message), so the word `TTSTextFrame` objects are pushed in bursts rather
 * than evenly spread across playback. Each frame still carries an accurate
 * `pts`, so consumers should schedule off `pts` rather than arrival time.
 */
export class XAITTSService extends WebsocketTTSService {
  static Settings: typeof XAIWebsocketTTSSettings = XAIWebsocketTTSSettings;
  declare protected _settings: XAIWebsocketTTSSettings;

  static {
    installTracedTts(XAITTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _codec: string;
  protected _receiveTask: Task<unknown> | null = null;

  protected _timestampContextId: string | null = null;
  protected _partialWord = "";
  protected _partialWordStartTime = 0.0;

  /**
   * Initialize the xAI WebSocket TTS service.
   *
   * @param options.apiKey xAI API key for authentication.
   * @param options.baseUrl xAI TTS WebSocket endpoint. Defaults to
   *   "wss://api.x.ai/v1/tts".
   * @param options.sampleRate Output audio sample rate in Hz. If null, uses
   *   the pipeline default.
   * @param options.codec Output audio codec. One of `pcm`, `wav`, `mulaw`,
   *   `alaw`. Defaults to `pcm`.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent `WebsocketTTSService`.
   */
  constructor(options: XAITTSServiceOptions) {
    const defaultSettings = new (new.target as typeof XAITTSService).Settings({
      model: null,
      voice: "eve",
      language: Language.EN,
      speed: null,
      optimizeStreamingLatency: null,
      textNormalization: null,
      withTimestamps: true,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    // With word timestamps enabled, per-word TTSTextFrames drive the text
    // output, so suppress the base class's aggregated text frame. Without
    // them, fall back to the normal aggregated-text behavior.
    const withTimestamps = Boolean(assertGiven(defaultSettings.withTimestamps));

    super({
      ...options,
      pushStartFrame: true,
      pushStopFrames: true,
      pushTextFrames: !withTimestamps,
      appendTrailingSpace: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "wss://api.x.ai/v1/tts";
    this._codec = options.codec ?? "pcm";
    this._receiveTask = null;
  }

  protected _resetTimestampState(): void {
    this._timestampContextId = null;
    this._partialWord = "";
    this._partialWordStartTime = 0.0;
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /** Convert a Language enum to xAI language format. */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToXaiLanguage(language);
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

  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /** Apply a settings delta. Reconnects if any URL-baked field changes. */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length > 0) {
      await this._disconnect();
      await this._connect();
    }

    return changed;
  }

  _buildUrl(): string {
    const language = this._settings.language;
    let languageValue: string;
    if (typeof language === "string" && isLanguage(language)) {
      languageValue = languageToXaiLanguage(language) || language;
    } else {
      languageValue = language !== null ? languageString(language) : "auto";
    }

    const params = new URLSearchParams();
    params.append("voice", String(this._settings.voice));
    params.append("language", languageValue);
    params.append("codec", this._codec);
    params.append("sample_rate", String(this.sampleRate));
    if (assertGiven(this._settings.speed) !== null) {
      params.append("speed", String(this._settings.speed));
    }
    if (assertGiven(this._settings.optimizeStreamingLatency) !== null) {
      params.append("optimize_streaming_latency", String(this._settings.optimizeStreamingLatency));
    }
    // xAI expects "true"/"false" for booleans.
    if (assertGiven(this._settings.textNormalization) !== null) {
      params.append("text_normalization", String(this._settings.textNormalization).toLowerCase());
    }
    if (assertGiven(this._settings.withTimestamps) !== null) {
      params.append("with_timestamps", String(this._settings.withTimestamps).toLowerCase());
    }
    return `${this._baseUrl}?${params.toString()}`;
  }

  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to xAI TTS");

      const url = this._buildUrl();
      const headers = { Authorization: `Bearer ${this._apiKey}` };
      this._websocket = await this._websocketConnect(url, { additionalHeaders: headers });

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug("Disconnecting from xAI TTS");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting from xAI TTS: ${errorMessage(e)}`, {
        exception: e,
      });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  protected _getWebsocket() {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Signal end-of-utterance so xAI begins synthesizing what it has buffered. */
  override async flushAudio(_contextId: string | null = null): Promise<void> {
    if (!this._websocket || this._websocket.state === State.CLOSED) {
      return;
    }
    await this._getWebsocket().send(pyJsonDumps({ type: "text.done" }));
  }

  /** Cancel the current xAI utterance on barge-in without reconnecting. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    if (this._websocket && this._websocket.state === State.OPEN) {
      await this._getWebsocket().send(pyJsonDumps({ type: "text.clear" }));
    }
    this._resetTimestampState();
    await super.onAudioContextInterrupted(contextId);
  }

  /** Mark a context finished: emit its stop frame and drop it. */
  protected async _closeAudioContext(contextId: string): Promise<void> {
    await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
    await this.removeAudioContext(contextId);
  }

  /** Emit word-timestamp frames from an `audio.delta` timing payload. */
  protected async _handleWordTimestamps(msg: Dict, contextId: string): Promise<void> {
    const timestamps = msg.audio_timestamps;
    if (!timestamps) {
      return;
    }
    const graphChars = timestamps.graph_chars;
    const graphTimes = timestamps.graph_times;
    if (!graphChars?.length || !graphTimes?.length) {
      return;
    }

    // A new utterance clears any word carried over from the previous one.
    if (contextId !== this._timestampContextId) {
      this._resetTimestampState();
      this._timestampContextId = contextId;
    }

    const [wordTimes, partialWord, partialWordStartTime] = _xaiWordTimes(
      graphChars,
      graphTimes,
      this._partialWord,
      this._partialWordStartTime,
    );
    this._partialWord = partialWord;
    this._partialWordStartTime = partialWordStartTime;

    if (wordTimes.length > 0) {
      await this.addWordTimestamps(wordTimes, contextId);
    }
  }

  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      if (typeof message !== "string") {
        logger.warning(`${this}: unexpected binary frame from xAI TTS`);
        continue;
      }
      let msg: Dict;
      try {
        msg = pyJsonLoads(message) as Dict;
      } catch (e) {
        rethrowIfCancelled(e);
        if (e instanceof SyntaxError) {
          logger.error(`${this}: invalid JSON message: ${message}`);
          continue;
        }
        throw e;
      }

      const msgType = msg?.type;
      const contextId = this.getActiveAudioContextId();

      if (msgType === "audio.delta") {
        const audioB64: string | undefined = msg.delta;
        if (audioB64) {
          await this.stopTtfbMetrics();
        }
        if (contextId) {
          if (audioB64) {
            const frame = new TTSAudioRawFrame({
              audio: base64ToBytes(audioB64),
              sampleRate: this.sampleRate,
              numChannels: 1,
              contextId,
            });
            await this.appendToAudioContext(contextId, frame);
          }
          // Timestamps arrive in their own (sometimes audio-less) deltas.
          await this._handleWordTimestamps(msg, contextId);
        }
      } else if (msgType === "audio.done") {
        await this.stopAllMetrics();
        if (contextId) {
          // Flush a trailing word that had no terminating space.
          if (this._timestampContextId === contextId && this._partialWord) {
            await this.addWordTimestamps(
              [[this._partialWord, this._partialWordStartTime]],
              contextId,
            );
          }
          this._resetTimestampState();
          await this._closeAudioContext(contextId);
        }
      } else if (msgType === "error") {
        await this.stopAllMetrics();
        this._resetTimestampState();
        const errorDetail = msg.message || msg.error || pyJsonDumps(msg);
        if (contextId) {
          await this._closeAudioContext(contextId);
        }
        await this.pushError(`xAI TTS error: ${errorDetail}`);
      } else if (msgType === "audio.clear") {
        logger.trace(`${this}: xAI acknowledged audio clear`);
      } else {
        logger.debug(`${this}: unhandled xAI message type: ${msgType}`);
      }
    }
  }

  /** Generate TTS audio from text using xAI's streaming WebSocket API. */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      let failure: unknown = null;
      try {
        await this._getWebsocket().send(pyJsonDumps({ type: "text.delta", delta: text }));
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
