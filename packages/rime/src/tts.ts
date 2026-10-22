// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/rime/tts.py

/**
 * Rime text-to-speech service implementations.
 *
 * This module provides both WebSocket and HTTP-based text-to-speech services
 * using Rime's API for streaming and batch audio synthesis.
 *
 * Porting notes:
 * - `RimeTTSService` uses the global `WebSocket` through
 *   `WebsocketService._websocketConnect()`; the `Authorization` header is sent
 *   on the opening handshake on Bun, Node, Deno and (through `fetch`) Workers.
 * - `RimeHttpTTSService` posts with `fetch`. DIVERGENCE: upstream's required
 *   `aiohttp_session` becomes an optional `fetch` option.
 * - Deprecated APIs are not ported: `RimeNonJsonTTSService` and its settings,
 *   the `InputParams` classes, and the `voice_id`, `model`, `params` and
 *   `aggregate_sentences` constructor parameters.
 * - Settings fields are camelCase (`repetition_penalty` is `repetitionPenalty`,
 *   `top_p` is `topP`); the wire names are unchanged.
 */

import { abortable, currentSignal, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSStartedFrame,
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
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { SkipTagsAggregator } from "@pipedog/core/utils/text/skip_tags_aggregator";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `str(x)` for the scalars that end up in a URL query (`True`, `1.0`). */
function pyStr(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

const LANGUAGE_MAP: Partial<Record<Language, string>> = {
  [Language.AR]: "ara",
  [Language.DE]: "ger",
  [Language.EN]: "eng",
  [Language.ES]: "spa",
  [Language.FR]: "fra",
  [Language.HI]: "hin",
  [Language.IT]: "ita",
  [Language.JA]: "jpn",
  [Language.PT]: "por",
};

/**
 * Convert a Language to a Rime language code.
 *
 * @param language The Language value.
 * @returns Language code used by Rime (e.g., 'eng' for English). Rime accepts
 *   both ISO 639-2/3 and ISO 639-1 codes, so a region-qualified language falls
 *   back to its two-letter base code.
 */
export function languageToRimeLanguage(language: Language): string {
  return resolveLanguage(language, LANGUAGE_MAP);
}

export interface RimeTTSSettingsOptions extends TTSSettingsOptions {
  /** Text segmentation mode ("immediate", "bySentence", "never"). */
  segment?: string | null | NotGiven;
  /** Speech speed multiplier (mistv2 only). */
  speedAlpha?: number | null | NotGiven;
  /** Whether to reduce latency at potential quality cost (mistv2 only). */
  reduceLatency?: boolean | null | NotGiven;
  /** Whether to add pauses between bracketed content (mistv2 only). */
  pauseBetweenBrackets?: boolean | null | NotGiven;
  /** Whether to phonemize bracketed content (mistv2 only). */
  phonemizeBetweenBrackets?: boolean | null | NotGiven;
  /** Whether to disable text normalization (mistv2 only). */
  noTextNormalization?: boolean | null | NotGiven;
  /** Whether to save out-of-vocabulary words (mistv2 only). */
  saveOovs?: boolean | null | NotGiven;
  /** Inline speed control markup. */
  inlineSpeedAlpha?: string | null | NotGiven;
  /** Token repetition penalty for Coda requests (1.0-2.0). Wire name `repetition_penalty`. */
  repetitionPenalty?: number | null | NotGiven;
  /** Sampling temperature for Coda requests (0.0-1.0). */
  temperature?: number | null | NotGiven;
  /** Cumulative probability threshold for Coda requests (0.0-1.0). Wire name `top_p`. */
  topP?: number | null | NotGiven;
  /**
   * Audio playback speed factor for Coda requests. Values above 1.0 slow down
   * the audio; values below 1.0 speed it up.
   */
  timeScaleFactor?: number | null | NotGiven;
}

/**
 * Settings for RimeTTSService and RimeHttpTTSService.
 *
 * - `segment`: text segmentation mode ("immediate", "bySentence", "never").
 * - `speedAlpha`: speech speed multiplier (mistv2 only).
 * - `reduceLatency`: whether to reduce latency at potential quality cost
 *   (mistv2 only).
 * - `pauseBetweenBrackets`: whether to add pauses between bracketed content
 *   (mistv2 only).
 * - `phonemizeBetweenBrackets`: whether to phonemize bracketed content
 *   (mistv2 only).
 * - `noTextNormalization`: whether to disable text normalization (mistv2 only).
 * - `saveOovs`: whether to save out-of-vocabulary words (mistv2 only).
 * - `inlineSpeedAlpha`: inline speed control markup.
 * - `repetitionPenalty`: token repetition penalty for Coda requests (1.0-2.0).
 * - `temperature`: sampling temperature for Coda requests (0.0-1.0).
 * - `topP`: cumulative probability threshold for Coda requests (0.0-1.0).
 * - `timeScaleFactor`: audio playback speed factor for Coda requests. Values
 *   above 1.0 slow down the audio; values below 1.0 speed it up.
 */
export class RimeTTSSettings extends TTSSettings {
  segment: string | null | NotGiven = NOT_GIVEN;
  speedAlpha: number | null | NotGiven = NOT_GIVEN;
  reduceLatency: boolean | null | NotGiven = NOT_GIVEN;
  pauseBetweenBrackets: boolean | null | NotGiven = NOT_GIVEN;
  phonemizeBetweenBrackets: boolean | null | NotGiven = NOT_GIVEN;
  noTextNormalization: boolean | null | NotGiven = NOT_GIVEN;
  saveOovs: boolean | null | NotGiven = NOT_GIVEN;
  inlineSpeedAlpha: string | null | NotGiven = NOT_GIVEN;
  repetitionPenalty: number | null | NotGiven = NOT_GIVEN;
  temperature: number | null | NotGiven = NOT_GIVEN;
  topP: number | null | NotGiven = NOT_GIVEN;
  timeScaleFactor: number | null | NotGiven = NOT_GIVEN;

  static override _aliases: Record<string, string> = { speaker: "voice" };

  constructor(options: RimeTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface RimeTTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Rime API key for authentication. */
  apiKey: string;
  /** Rime websocket API endpoint. Defaults to "wss://users-ws.rime.ai/ws3". */
  url?: string;
  /** Runtime-updatable settings (defaults: model "coda"). */
  settings?: RimeTTSSettings | null;
}

/**
 * Text-to-Speech service using Rime's websocket API.
 *
 * Uses Rime's websocket JSON API to convert text to speech with word-level
 * timing information. Supports interruptions and maintains context across
 * multiple messages within a turn.
 */
export class RimeTTSService extends WebsocketTTSService {
  static Settings: typeof RimeTTSSettings = RimeTTSSettings;
  declare protected _settings: RimeTTSSettings;

  static {
    installTracedTts(RimeTTSService.prototype, "runTts");
  }

  protected _audioFormat: string;
  protected _samplingRate: number;
  protected _apiKey: string;
  protected _url: string;
  protected _receiveTask: Task<unknown> | null;
  protected _cumulativeTime: number;
  protected _extraMsgFields: Dict;

  /**
   * Initialize Rime TTS service.
   *
   * @param options.apiKey Rime API key for authentication.
   * @param options.url Rime websocket API endpoint.
   * @param options.sampleRate Audio sample rate in Hz.
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate incoming text before
   *   synthesis. Other options are passed to the parent class.
   */
  constructor(options: RimeTTSServiceOptions) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new (new.target as typeof RimeTTSService).Settings({
      model: "coda",
      voice: null,
      language: null,
      segment: null,
      inlineSpeedAlpha: null,
      speedAlpha: null,
      repetitionPenalty: null,
      temperature: null,
      topP: null,
      // Mistv2 params
      reduceLatency: null,
      pauseBetweenBrackets: null,
      phonemizeBetweenBrackets: null,
      noTextNormalization: null,
      saveOovs: null,
      timeScaleFactor: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushTextFrames: false,
      pauseFrameProcessing: true,
      appendTrailingSpace: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    // Init-only audio format fields (not runtime-updatable)
    this._audioFormat = "pcm";
    this._samplingRate = 0; // updated in setup()

    // Always skip tags added for spelled-out text
    // Note: This is primarily to support backwards compatibility.
    //    The preferred way of taking advantage of Rime spelling is
    //    to use an LLMTextProcessor and/or a textTransformer to identify
    //    and insert these tags for the purpose of the TTS service alone.
    this._textAggregator = new SkipTagsAggregator({
      tags: [["spell(", ")"]],
      aggregationType: this._textAggregationMode,
    });

    // Store service configuration
    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://users-ws.rime.ai/ws3";

    // State tracking
    this._receiveTask = null;
    this._cumulativeTime = 0; // Accumulates time across messages
    this._extraMsgFields = {}; // Extra fields for next message
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Rime service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to Rime language code.
   *
   * @param language The language to convert.
   * @returns The Rime-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToRimeLanguage(language);
  }

  /**
   * Build query params for the WebSocket URL from current settings.
   *
   * @returns Dictionary of query parameters for the WebSocket URL. Only
   *   explicitly-set values are included. Boolean mistv2 params are serialized
   *   with `pyJsonDumps()` for the wire format.
   */
  protected _buildWsParams(): Dict {
    const s = this._settings;
    const params: Dict = {
      speaker: s.voice,
      modelId: s.model,
      audioFormat: this._audioFormat,
      samplingRate: this._samplingRate,
    };
    if (s.language !== null) {
      params.lang = s.language;
    }
    if (s.segment !== null) {
      params.segment = s.segment;
    }
    if (s.speedAlpha !== null) {
      params.speedAlpha = s.speedAlpha;
    }

    if (s.model === "coda") {
      if (s.repetitionPenalty !== null) {
        params.repetition_penalty = s.repetitionPenalty;
      }
      if (s.temperature !== null) {
        params.temperature = s.temperature;
      }
      if (s.topP !== null) {
        params.top_p = s.topP;
      }
      if (s.timeScaleFactor !== null) {
        params.timeScaleFactor = s.timeScaleFactor;
      }
    } else {
      // mistv2/mist
      if (s.reduceLatency !== null) {
        params.reduceLatency = s.reduceLatency;
      }
      if (s.pauseBetweenBrackets !== null) {
        params.pauseBetweenBrackets = pyJsonDumps(s.pauseBetweenBrackets);
      }
      if (s.phonemizeBetweenBrackets !== null) {
        params.phonemizeBetweenBrackets = pyJsonDumps(s.phonemizeBetweenBrackets);
      }
      if (s.noTextNormalization !== null) {
        params.noTextNormalization = pyJsonDumps(s.noTextNormalization);
      }
      if (s.saveOovs !== null) {
        params.saveOovs = pyJsonDumps(s.saveOovs);
      }
    }

    return params;
  }

  // A set of Rime-specific helpers for text transformations

  /** Wrap text in Rime spell function. */
  static SPELL(text: string): string {
    return `spell(${text})`;
  }

  /**
   * Convenience method to create a pause tag.
   *
   * DIVERGENCE: JS cannot tell `1.0` from `1`, so a whole number of
   * milliseconds is written `500` where Python writes `500.0`.
   */
  static PAUSE_TAG(seconds: number): string {
    return `<${seconds * 1000}>`;
  }

  /**
   * Convenience method to support Rime's custom pronunciations feature.
   *
   * https://docs.rime.ai/api-reference/custom-pronunciation
   */
  PRONOUNCE(text: string, word: string, phoneme: string): string {
    this._extraMsgFields.phonemizeBetweenBrackets = true;
    return text.split(word).join(`{${phoneme}}`);
  }

  /** Convenience method to support inline speeds. */
  INLINE_SPEED(text: string, speed: number): string {
    const existing = this._extraMsgFields.inlineSpeedAlpha;
    this._extraMsgFields.inlineSpeedAlpha = existing ? `${existing},${speed}` : String(speed);
    return `[${text}]`;
  }

  /**
   * Apply a settings delta and reconnect if necessary.
   *
   * Since all settings are WebSocket URL query parameters, any setting change
   * requires reconnecting to apply the new values.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length > 0 && this._websocket) {
      await this._disconnect();
      await this._connect();
    }

    return changed;
  }

  /** Build JSON message for Rime API. */
  protected _buildMsg(text = "", contextId = ""): Dict {
    const msg: Dict = { text, contextId };
    if (Object.keys(this._extraMsgFields).length > 0) {
      Object.assign(msg, this._extraMsgFields);
      this._extraMsgFields = {};
    }
    return msg;
  }

  /** Build clear operation message. */
  protected _buildClearMsg(): Dict {
    return { operation: "clear" };
  }

  /** Build end-of-stream operation message. */
  protected _buildEosMsg(): Dict {
    return { operation: "eos" };
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._samplingRate = this.sampleRate;
    await this._connect();
  }

  /** Establish websocket connection and start receive task. */
  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /** Close websocket connection and clean up tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /** Connect to Rime websocket API with configured settings. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      const wsParams = this._buildWsParams();
      const params = Object.entries(wsParams)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${pyStr(v)}`)
        .join("&");
      const url = `${this._url}?${params}`;
      const headers = { Authorization: `Bearer ${this._apiKey}` };
      this._websocket = await this._websocketConnect(url, { additionalHeaders: headers });

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", errorMessage(e));
    }
  }

  /** Close websocket connection and reset state. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();
      if (this._websocket) {
        await this._websocket.send(pyJsonDumps(this._buildEosMsg()));
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error disconnecting: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      await this._callEventHandler("on_disconnected");
    }
  }

  /** Get active websocket connection or raise exception. */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Clear the Rime speech queue and stop metrics. */
  protected async _closeContext(contextId: string): Promise<void> {
    await this.stopAllMetrics();
    if (contextId) {
      await this._getWebsocket().send(pyJsonDumps(this._buildClearMsg()));
    }
  }

  /** Clear the Rime speech queue and stop metrics when the bot is interrupted. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this._closeContext(contextId);
    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * Clear server-side state and stop metrics after the Rime context finishes
   * playing.
   *
   * Sends a `clear` message to clean up any residual server-side state once
   * all audio has been delivered.
   */
  override async onAudioContextCompleted(contextId: string): Promise<void> {
    await this._closeContext(contextId);
    await super.onAudioContextCompleted(contextId);
  }

  /**
   * Calculate word timing pairs with proper spacing and punctuation.
   *
   * @param words List of words from Rime.
   * @param starts List of start times for each word.
   * @param ends List of end times for each word.
   * @returns List of (word, timestamp) pairs with proper timing.
   */
  protected _calculateWordTimes(
    words: string[],
    starts: number[],
    ends: number[],
  ): [string, number][] {
    const wordPairs: [string, number][] = [];
    const n = Math.min(words.length, starts.length, ends.length);
    for (let i = 0; i < n; i++) {
      const word = words[i]!;
      const startTime = starts[i]!;
      if (!word.trim()) {
        continue;
      }

      // Adjust timing by adding cumulative time
      const adjustedStart = startTime + this._cumulativeTime;

      // Handle punctuation by appending to previous word
      const isPunctuation = word.replace(/^[,.!?]+|[,.!?]+$/g, "") === "";
      if (isPunctuation && wordPairs.length > 0) {
        const [prevWord, prevTime] = wordPairs[wordPairs.length - 1]!;
        wordPairs[wordPairs.length - 1] = [prevWord + word, prevTime];
      } else {
        wordPairs.push([word, adjustedStart]);
      }
    }

    return wordPairs;
  }

  /** Flush any pending audio synthesis. */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (!flushId || !this._websocket) {
      return;
    }

    logger.trace(`${this}: flushing audio`);
    await this._getWebsocket().send(pyJsonDumps({ operation: "flush" }));
  }

  /** Process incoming websocket messages. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const msg = pyJsonLoads(
        typeof message === "string" ? message : new TextDecoder().decode(message),
      ) as Dict | null;

      if (
        !msg ||
        Object.keys(msg).length === 0 ||
        msg.contextId === undefined ||
        msg.contextId === null ||
        !this.audioContextAvailable(msg.contextId)
      ) {
        continue;
      }

      const contextId: string = msg.contextId;
      if (msg.type === "chunk") {
        // Process audio chunk
        const frame = new TTSAudioRawFrame({
          audio: base64ToBytes(msg.data),
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId,
        });
        await this.appendToAudioContext(contextId, frame);
      } else if (msg.type === "timestamps") {
        // Process word timing information
        const timestamps = msg.word_timestamps ?? {};
        const words: string[] = timestamps.words ?? [];
        const starts: number[] = timestamps.start ?? [];
        const ends: number[] = timestamps.end ?? [];

        if (words.length > 0 && starts.length > 0) {
          // Calculate word timing pairs
          const wordPairs = this._calculateWordTimes(words, starts, ends);
          if (wordPairs.length > 0) {
            await this.addWordTimestamps(wordPairs, contextId);
            this._cumulativeTime = ends[ends.length - 1]! + this._cumulativeTime;
            logger.debug(`Updated cumulative time to: ${this._cumulativeTime}`);
          }
        }
      } else if (msg.type === "done") {
        await this.stopTtfbMetrics();
        await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
        await this.removeAudioContext(contextId);
      } else if (msg.type === "error") {
        await this.pushFrame(new TTSStoppedFrame());
        await this.stopAllMetrics();
        await this.pushError(`Error: ${msg.message}`);
        this.resetActiveAudioContext();
      }
    }
  }

  /**
   * Generate speech from text using Rime's streaming API.
   *
   * @param text The text to convert to speech.
   * @param contextId Unique identifier for this TTS context.
   * @yields Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      try {
        if (!this.audioContextAvailable(contextId)) {
          await this.createAudioContext(contextId);
          await this.startTtfbMetrics();
          yield new TTSStartedFrame({ contextId });
          this._cumulativeTime = 0;
        }

        const msg = this._buildMsg(text, contextId);
        await this._getWebsocket().send(pyJsonDumps(msg));
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
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

export interface RimeHttpTTSServiceOptions extends TTSServiceOptions {
  /** Rime API key for authentication. */
  apiKey: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Runtime-updatable settings (defaults: model "coda", language "eng"). */
  settings?: RimeTTSSettings | null;
}

/**
 * Rime HTTP-based text-to-speech service.
 *
 * Provides text-to-speech synthesis using Rime's HTTP API for batch
 * processing. Suitable for use cases where streaming is not required.
 */
export class RimeHttpTTSService extends TTSService {
  static Settings: typeof RimeTTSSettings = RimeTTSSettings;
  declare protected _settings: RimeTTSSettings;

  static {
    installTracedTts(RimeHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _fetch: typeof fetch;
  protected _baseUrl: string;
  protected _audioFormat: string;

  /**
   * Initialize Rime HTTP TTS service.
   *
   * @param options.apiKey Rime API key for authentication.
   * @param options.fetch `fetch` used for HTTP requests.
   * @param options.sampleRate Audio sample rate in Hz.
   * @param options.settings Runtime-updatable settings. Other options are
   *   passed to the parent TTSService.
   */
  constructor(options: RimeHttpTTSServiceOptions) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new (new.target as typeof RimeHttpTTSService).Settings({
      model: "coda",
      voice: null,
      language: "eng",
      segment: null,
      speedAlpha: null,
      reduceLatency: null,
      pauseBetweenBrackets: null,
      phonemizeBetweenBrackets: null,
      noTextNormalization: null,
      saveOovs: null,
      inlineSpeedAlpha: null,
      repetitionPenalty: null,
      temperature: null,
      topP: null,
      timeScaleFactor: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      pushStopFrames: true,
      pushStartFrame: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this._baseUrl = "https://users.rime.ai/v1/rime-tts";

    // Init-only audio format fields (not runtime-updatable)
    this._audioFormat = "pcm";
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Rime HTTP service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to Rime language code.
   *
   * @param language The language to convert.
   * @returns The Rime-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToRimeLanguage(language);
  }

  /**
   * Generate speech from text using Rime's HTTP API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @yields Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const headers = {
      Accept: "audio/pcm",
      Authorization: `Bearer ${this._apiKey}`,
      "Content-Type": "application/json",
    };

    const s = this._settings;
    const payload: Dict = {
      text,
      speaker: s.voice,
      modelId: s.model,
      samplingRate: this.sampleRate,
    };
    if (s.language !== null) {
      payload.lang = s.language;
    }
    if (s.speedAlpha !== null) {
      payload.speedAlpha = s.speedAlpha;
    }
    if (s.inlineSpeedAlpha !== null) {
      payload.inlineSpeedAlpha = s.inlineSpeedAlpha;
    }

    if (s.model === "coda") {
      if (s.repetitionPenalty !== null) {
        payload.repetition_penalty = s.repetitionPenalty;
      }
      if (s.temperature !== null) {
        payload.temperature = s.temperature;
      }
      if (s.topP !== null) {
        payload.top_p = s.topP;
      }
      if (s.timeScaleFactor !== null) {
        payload.timeScaleFactor = s.timeScaleFactor;
      }
    } else {
      // mistv2/mist
      if (s.reduceLatency !== null) {
        payload.reduceLatency = s.reduceLatency;
      }
      if (s.pauseBetweenBrackets !== null) {
        payload.pauseBetweenBrackets = s.pauseBetweenBrackets;
      }
      if (s.phonemizeBetweenBrackets !== null) {
        payload.phonemizeBetweenBrackets = s.phonemizeBetweenBrackets;
      }
      if (s.noTextNormalization !== null) {
        payload.noTextNormalization = s.noTextNormalization;
      }
    }

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
        yield new ErrorFrame({ error: `Rime TTS error: HTTP ${response.status}` });
        return;
      }

      await this.startTtsUsageMetrics(text);

      for await (const frame of this._streamAudioFramesFromIterator(
        iterChunked(response.body, this.chunkSize),
        { stripWavHeader: false, contextId },
      )) {
        await this.stopTtfbMetrics();
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}
