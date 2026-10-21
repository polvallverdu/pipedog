// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/inworld/tts.py

/**
 * Inworld AI Text-to-Speech Service Implementation.
 *
 * Contains two TTS services:
 * - InworldTTSService: WebSocket-based TTS service.
 * - InworldHttpTTSService: HTTP-based TTS service.
 *
 * Inworld's text-to-speech (TTS) models offer ultra-realistic, context-aware
 * speech synthesis and precise voice cloning capabilities, enabling developers
 * to build natural and engaging experiences with human-like speech quality at
 * an accessible price point.
 *
 * Porting notes:
 * - `InworldTTSService` connects with `WebsocketService._websocketConnect()`
 *   (core's `websocketConnect`), sending the `Authorization` header on the
 *   opening handshake (through `fetch` on Cloudflare Workers).
 * - `InworldHttpTTSService` posts with `fetch` (the global one by default,
 *   injectable with the `fetch` option) in place of an `aiohttp` session.
 * - Deprecated APIs are not ported: the `voice_id`, `model` and `params`
 *   constructor parameters (and the `InputParams` classes), and
 *   `aggregate_sentences`. Without `params`, the websocket buffer settings
 *   (`maxBufferDelayMs`, `bufferCharThreshold`) always take their defaults.
 * - The user agent is `pipecat/<pipedog version>`.
 */

import { abortable, currentSignal, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import {
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  TextType,
  TTSAudioRawFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection, type FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import {
  type ServiceSettings,
  TTSSettings,
  type TTSSettingsOptions,
} from "@pipedog/core/services/settings";
import {
  type TextAggregationMode,
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
import { normalizeIpa } from "@pipedog/core/utils/text/phonemes";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

// Upstream `dict[str, Any]`: Inworld JSON payloads are genuinely dynamic.
type Dict = Record<string, any>;

const USER_AGENT = `pipecat/${pipecatVersion()}`;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Python's `dict.get(key, {})` on a JSON object. */
function getDict(obj: Dict | null | undefined, key: string): Dict {
  const value = obj?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Whether `audio` is a WAV file (a RIFF header followed by data). */
function hasWavHeader(audio: Uint8Array): boolean {
  return (
    audio.length > 44 &&
    audio[0] === 0x52 && // R
    audio[1] === 0x49 && // I
    audio[2] === 0x46 && // F
    audio[3] === 0x46 // F
  );
}

const LANGUAGE_MAP: Partial<Record<Language, string>> = {
  [Language.AR]: "ar-SA",
  [Language.DE]: "de-DE",
  [Language.EN]: "en-US",
  [Language.ES]: "es-ES",
  [Language.FR]: "fr-FR",
  [Language.HE]: "he-IL",
  [Language.HI]: "hi-IN",
  [Language.IT]: "it-IT",
  [Language.JA]: "ja-JP",
  [Language.KO]: "ko-KR",
  [Language.NL]: "nl-NL",
  [Language.PL]: "pl-PL",
  [Language.PT]: "pt-BR",
  [Language.RU]: "ru-RU",
  [Language.ZH]: "zh-CN",
};

/**
 * Convert a Language value to an Inworld TTS BCP-47 language tag.
 *
 * @param language The Language value to convert.
 * @returns The corresponding Inworld BCP-47 language tag (e.g. `"en-US"`).
 *   Unverified languages fall back to their BCP-47 string value with a
 *   warning.
 */
export function languageToInworldLanguage(language: Language): string {
  return resolveLanguage(language, LANGUAGE_MAP, false);
}

/**
 * Render a pronunciation as IPA between slashes, as Inworld reads it.
 *
 * Inworld speaks the IPA wherever it appears inline, one word per pair of
 * slashes, so a pronunciation covering several words cannot be written. Only
 * English IPA symbols are read.
 *
 * @param _word The word being pronounced (unused: the IPA replaces it).
 * @param ipa The pronunciation, in IPA.
 * @returns The IPA wrapped in slashes, e.g. `/kriːt/`, or null for an empty
 *   pronunciation or one spanning several words.
 */
export function formatInworldPronunciation(_word: string, ipa: string): string | null {
  const normalized = normalizeIpa(ipa);
  return normalized && !normalized.includes(" ") ? `/${normalized}/` : null;
}

/** Inworld's stability vs. creativity tradeoff. */
export type InworldDeliveryMode = "STABLE" | "BALANCED" | "CREATIVE";

/** Strategy for timestamp transport. */
export type InworldTimestampTransportStrategy = "ASYNC" | "SYNC";

export interface InworldTTSSettingsOptions extends TTSSettingsOptions {
  /** Speaking rate for speech synthesis. */
  speakingRate?: number | null | NotGiven;
  /** Temperature for speech synthesis. */
  temperature?: number | null | NotGiven;
  /**
   * Controls the stability vs. creativity tradeoff. `"STABLE"` produces
   * reliable, predictable speech. `"BALANCED"` is the default midpoint.
   * `"CREATIVE"` produces more expressive, emotionally varied speech. Only
   * supported by `inworld-tts-2`.
   */
  deliveryMode?: InworldDeliveryMode | null | NotGiven;
}

/**
 * Settings for InworldTTSService and InworldHttpTTSService.
 *
 * - `speakingRate`: speaking rate for speech synthesis.
 * - `temperature`: temperature for speech synthesis.
 * - `deliveryMode`: controls the stability vs. creativity tradeoff.
 *   `"STABLE"` produces reliable, predictable speech. `"BALANCED"` is the
 *   default midpoint. `"CREATIVE"` produces more expressive, emotionally
 *   varied speech. Only supported by `inworld-tts-2`.
 */
export class InworldTTSSettings extends TTSSettings {
  speakingRate: number | null | NotGiven = NOT_GIVEN;
  temperature: number | null | NotGiven = NOT_GIVEN;
  deliveryMode: InworldDeliveryMode | null | NotGiven = NOT_GIVEN;

  static override _aliases: Record<string, string> = {
    voiceId: "voice",
    modelId: "model",
  };

  constructor(options: InworldTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }

  /**
   * Construct settings from a plain dict, destructuring legacy nested
   * `audioConfig`.
   */
  static override fromMapping<T extends ServiceSettings>(
    this: new (
      options?: object,
    ) => T,
    settings: Record<string, unknown>,
  ): T {
    const flat: Record<string, unknown> = { ...settings };
    const nested = flat.audioConfig;
    delete flat.audioConfig;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      if (!Object.hasOwn(flat, "speaking_rate")) {
        flat.speaking_rate = (nested as Dict).speakingRate ?? null;
      }
    }
    // Upstream's `super().from_mapping(flat)`, building an instance of this
    // class (`cls`): key resolution as in `ServiceSettings.fromMapping`.
    // biome-ignore lint/complexity/noThisInStatic: polymorphic classmethod.
    const cls = this as unknown as typeof InworldTTSSettings & (new (options?: object) => T);
    const fieldNames = new Set(new cls()._fieldNames());
    const kwargs: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flat)) {
      const canonical = cls._aliases[key] ?? key;
      if (fieldNames.has(canonical)) {
        kwargs[canonical] = value;
      } else if (fieldNames.has(snakeToCamel(canonical))) {
        kwargs[snakeToCamel(canonical)] = value;
      } else {
        extra[key] = value;
      }
    }
    const instance = new cls(kwargs);
    instance.extra = extra;
    return instance;
  }
}

/** Store-mode defaults shared by both services. */
function defaultInworldSettings(cls: typeof InworldTTSSettings): InworldTTSSettings {
  return new cls({
    model: "inworld-tts-2",
    voice: "Ashley",
    language: null,
    speakingRate: null,
    temperature: null,
    deliveryMode: null,
  });
}

/** Split a byte stream as `aiohttp`'s `iter_any()` does: chunks as they arrive. */
async function* iterAny(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (value && value.length > 0) yield value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed or errored.
    }
  }
}

export interface InworldHttpTTSServiceOptions extends TTSServiceOptions {
  /** Inworld API key. */
  apiKey: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Whether to use streaming mode. Defaults to true. */
  streaming?: boolean;
  /** Audio encoding format. Defaults to "PCM". */
  encoding?: string;
  /** Strategy for timestamp transport ("ASYNC" or "SYNC"). Defaults to "ASYNC". */
  timestampTransportStrategy?: InworldTimestampTransportStrategy | null;
  /**
   * Runtime-updatable settings. Its given fields override the defaults
   * (model "inworld-tts-2", voice "Ashley").
   */
  settings?: InworldTTSSettings | null;
}

/**
 * Inworld AI HTTP-based TTS service.
 *
 * Supports both streaming and non-streaming modes via the `streaming`
 * parameter. Outputs PCM audio at configurable sample rates with word-level
 * timestamps.
 */
export class InworldHttpTTSService extends TTSService {
  static Settings: typeof InworldTTSSettings = InworldTTSSettings;
  declare protected _settings: InworldTTSSettings;

  static {
    installTracedTts(InworldHttpTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _fetch: typeof fetch;
  protected _streaming: boolean;
  protected _timestampType: string;
  protected _baseUrl: string;
  protected _cumulativeTime: number;
  protected _currentRunHadTimestamps: boolean;
  // Init-only config (not runtime-updatable).
  protected _audioEncoding: string;
  protected _audioSampleRate: number;
  protected _timestampTransportStrategy: InworldTimestampTransportStrategy | null;

  /**
   * Initialize the Inworld TTS service.
   *
   * @param options.apiKey Inworld API key.
   * @param options.fetch `fetch` used for HTTP requests. Defaults to the
   *   global `fetch`.
   * @param options.streaming Whether to use streaming mode.
   * @param options.sampleRate Audio sample rate in Hz.
   * @param options.encoding Audio encoding format.
   * @param options.timestampTransportStrategy Strategy for timestamp transport
   *   ("ASYNC" or "SYNC"). Defaults to "ASYNC".
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent class.
   */
  constructor(options: InworldHttpTTSServiceOptions) {
    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = defaultInworldSettings(
      (new.target as typeof InworldHttpTTSService).Settings,
    );

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushTextFrames: false,
      pushStopFrames: true,
      pushStartFrame: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    const streaming = options.streaming ?? true;

    this._apiKey = options.apiKey;
    this._fetch = options.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch);
    this._streaming = streaming;
    this._timestampType = "WORD";

    if (streaming) {
      this._baseUrl = "https://api.inworld.ai/tts/v1/voice:stream";
    } else {
      this._baseUrl = "https://api.inworld.ai/tts/v1/voice";
    }

    this._cumulativeTime = 0.0;
    this._currentRunHadTimestamps = false;

    // Init-only config (not runtime-updatable).
    this._audioEncoding = options.encoding ?? "PCM";
    this._audioSampleRate = 0; // Set in setup()
    this._timestampTransportStrategy =
      options.timestampTransportStrategy === undefined
        ? "ASYNC"
        : options.timestampTransportStrategy;
  }

  /**
   * Render a pronunciation as IPA between slashes.
   *
   * See `formatInworldPronunciation`.
   *
   * @param word The word being pronounced.
   * @param ipa The pronunciation, in IPA.
   * @returns The IPA wrapped in slashes, or null when the pronunciation
   *   cannot be used.
   */
  static override formatPronunciation(word: string, ipa: string): string | null {
    return formatInworldPronunciation(word, ipa);
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Inworld TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to Inworld language format.
   *
   * @param language The language to convert.
   * @returns The Inworld-specific BCP-47 language code, or null if not
   *   supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToInworldLanguage(language);
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._audioSampleRate = this.sampleRate;
  }

  /**
   * Push a frame and handle state changes.
   *
   * @param frame The frame to push.
   * @param direction The direction to push the frame.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await super.pushFrame(frame, direction);
    if (frame instanceof InterruptionFrame || frame instanceof TTSStoppedFrame) {
      this._cumulativeTime = 0.0;
    }
  }

  /**
   * Calculate word timestamps from Inworld HTTP API word-level response.
   *
   * Note: Inworld HTTP provides timestamps that reset for each request. We
   * track cumulative time across requests to maintain continuity.
   *
   * @param timestampInfo The timestamp information from Inworld API.
   * @returns Tuple of [wordTimes, chunkEndTime] where chunkEndTime is the end
   *   time of the last word in this chunk (not cumulative).
   */
  protected _calculateWordTimes(timestampInfo: Dict): [[string, number][], number] {
    const wordTimes: [string, number][] = [];
    let chunkEndTime = 0.0;

    const alignment = getDict(timestampInfo, "wordAlignment");
    const words: string[] = alignment.words ?? [];
    const startTimes: number[] = alignment.wordStartTimeSeconds ?? [];
    const endTimes: number[] = alignment.wordEndTimeSeconds ?? [];

    if (words.length > 0 && startTimes.length > 0 && words.length === startTimes.length) {
      words.forEach((word, i) => {
        const wordStart = this._cumulativeTime + (startTimes[i] as number);
        wordTimes.push([word, wordStart]);
      });

      // Track the end time of the last word in this chunk
      if (endTimes.length > 0) {
        chunkEndTime = endTimes.at(-1) as number;
      }
    }

    return [wordTimes, chunkEndTime];
  }

  /**
   * Generate TTS audio for the given text.
   *
   * @param text The text to generate TTS audio for.
   * @param contextId Unique identifier for this TTS context.
   * @returns An asynchronous generator of frames.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    this._currentRunHadTimestamps = false;

    const audioConfig: Dict = {
      audioEncoding: this._audioEncoding,
      sampleRateHertz: this._audioSampleRate,
    };
    const speakingRate = assertGiven(this._settings.speakingRate);
    if (speakingRate !== null) {
      audioConfig.speakingRate = speakingRate;
    }

    const payload: Dict = {
      text,
      voiceId: this._settings.voice,
      modelId: this._settings.model,
      audioConfig,
    };

    const temperature = assertGiven(this._settings.temperature);
    if (temperature !== null) {
      payload.temperature = temperature;
    }
    const deliveryMode = assertGiven(this._settings.deliveryMode);
    if (deliveryMode !== null) {
      payload.deliveryMode = deliveryMode;
    }
    const language = assertGiven(this._settings.language);
    if (language !== null) {
      payload.language = language;
    }

    // Use WORD timestamps for simplicity and correct spacing/capitalization
    payload.timestampType = this._timestampType;
    if (this._timestampTransportStrategy !== null) {
      payload.timestampTransportStrategy = this._timestampTransportStrategy;
    }

    const requestId = crypto.randomUUID();
    const headers: Record<string, string> = {
      Authorization: `Basic ${this._apiKey}`,
      "Content-Type": "application/json",
      "X-User-Agent": USER_AGENT,
      "X-Request-Id": requestId,
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
      try {
        if (response.status !== 200) {
          const errorText = await abortable(response.text());
          logger.error(`Inworld API error (request_id=${requestId}): ${errorText}`);
          yield new ErrorFrame({ error: `Inworld API error: ${errorText}` });
          return;
        }

        if (this._streaming) {
          yield* this._processStreamingResponse(response, contextId);
        } else {
          yield* this._processNonStreamingResponse(response, contextId);
        }
      } finally {
        if (!response.bodyUsed) {
          try {
            await response.body?.cancel();
          } catch {
            // The body is already closed.
          }
        }
      }

      await this.startTtsUsageMetrics(text);

      // If no timestamps were received, push the full text so the LLM
      // conversation context still reflects what the agent spoke. On
      // interruption this means the full text is committed rather than
      // only the portion that was spoken.
      if (!this._currentRunHadTimestamps) {
        const textClean = text.trimEnd();
        if (textClean) {
          logger.debug(`${this}: No timestamps received, pushing fallback text: [${textClean}]`);
          const fallback = new TTSTextFrame({
            text: textClean,
            textType: TextType.SENTENCE,
            contextId,
          });
          const ctx = this._ttsContexts.get(contextId);
          fallback.appendToContext = ctx ? ctx.appendToContext : true;
          await this.pushFrame(fallback);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      await this.stopAllMetrics();
    }
  }

  /**
   * Process a streaming response from the Inworld API.
   *
   * @param response The response from the Inworld API.
   * @param contextId Unique identifier for this TTS context.
   * @returns An asynchronous generator of frames.
   */
  protected async *_processStreamingResponse(
    response: Response,
    contextId: string,
  ): AsyncGenerator<Frame, void> {
    let buffer = new Uint8Array(0);
    // Track the duration of this utterance based on the last word's end time
    let utteranceDuration = 0.0;
    const decoder = new TextDecoder("utf-8");

    for await (const chunk of iterAny(response.body)) {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer);
      merged.set(chunk, buffer.length);
      buffer = merged;

      let nl = buffer.indexOf(0x0a);
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf(0x0a);
        const lineStr = decoder.decode(line).trim();

        if (!lineStr) {
          continue;
        }

        let chunkData: Dict;
        try {
          chunkData = pyJsonLoads(lineStr) as Dict;
        } catch (e) {
          // json.JSONDecodeError
          rethrowIfCancelled(e);
          continue;
        }

        const result =
          chunkData && typeof chunkData === "object" && "result" in chunkData
            ? (chunkData.result as Dict)
            : null;

        if (result && typeof result === "object" && "audioContent" in result) {
          await this.stopTtfbMetrics();
          yield* this._processAudioChunk(base64ToBytes(result.audioContent), contextId);
        }

        if (result && typeof result === "object" && "timestampInfo" in result) {
          const timestampInfo = result.timestampInfo as Dict;
          const [wordTimes, chunkEndTime] = this._calculateWordTimes(timestampInfo);
          if (wordTimes.length > 0) {
            this._currentRunHadTimestamps = true;
            await this.addWordTimestamps(wordTimes, contextId, { preMergeTokens: true });
          }
          // Track the maximum end time across all chunks
          utteranceDuration = Math.max(utteranceDuration, chunkEndTime);
        }
      }
    }

    // After processing all chunks, add the total utterance duration
    // to the cumulative time to ensure next utterance starts after this one
    if (utteranceDuration > 0) {
      this._cumulativeTime += utteranceDuration;
    }
  }

  /**
   * Process a non-streaming response from the Inworld API.
   *
   * @param response The response from the Inworld API.
   * @param contextId Unique identifier for this TTS context.
   * @returns An asynchronous generator of frames.
   */
  protected async *_processNonStreamingResponse(
    response: Response,
    contextId: string,
  ): AsyncGenerator<Frame, void> {
    const responseData = pyJsonLoads(await abortable(response.text())) as Dict;

    if (!responseData || typeof responseData !== "object" || !("audioContent" in responseData)) {
      logger.error("No audioContent in Inworld API response");
      yield new ErrorFrame({ error: "No audioContent in response" });
      return;
    }

    let utteranceDuration = 0.0;
    if ("timestampInfo" in responseData) {
      const timestampInfo = responseData.timestampInfo as Dict;
      const [wordTimes, chunkEndTime] = this._calculateWordTimes(timestampInfo);
      if (wordTimes.length > 0) {
        this._currentRunHadTimestamps = true;
        await this.addWordTimestamps(wordTimes, contextId, { preMergeTokens: true });
      }
      utteranceDuration = chunkEndTime;
    }

    let audioData = base64ToBytes(responseData.audioContent);

    if (hasWavHeader(audioData)) {
      audioData = audioData.slice(44);
    }

    const chunkSize = this.chunkSize;
    for (let i = 0; i < audioData.length; i += chunkSize) {
      const chunk = audioData.slice(i, i + chunkSize);
      if (chunk.length > 0) {
        await this.stopTtfbMetrics();
        yield new TTSAudioRawFrame({
          audio: chunk,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId,
        });
      }
    }

    // After processing all audio, add the utterance duration to cumulative time
    if (utteranceDuration > 0) {
      this._cumulativeTime += utteranceDuration;
    }
  }

  /**
   * Process an audio chunk from the Inworld API.
   *
   * @param audioChunk The audio chunk to process.
   * @param contextId Unique identifier for this TTS context.
   * @returns An asynchronous generator of frames.
   */
  protected async *_processAudioChunk(
    audioChunk: Uint8Array,
    contextId: string,
  ): AsyncGenerator<Frame, void> {
    if (audioChunk.length === 0) {
      return;
    }

    let audioData = audioChunk;

    if (hasWavHeader(audioChunk)) {
      audioData = audioChunk.slice(44);
    }

    if (audioData.length > 0) {
      yield new TTSAudioRawFrame({
        audio: audioData,
        sampleRate: this.sampleRate,
        numChannels: 1,
        contextId,
      });
    }
  }
}

export interface InworldTTSServiceOptions extends WebsocketTTSServiceOptions {
  /** Inworld API key. */
  apiKey: string;
  /** URL of the Inworld WebSocket API. */
  url?: string;
  /** Audio encoding format. Defaults to "PCM". */
  encoding?: string;
  /**
   * Whether to use auto mode. When enabled, the server controls flushing of
   * buffered text. Defaults to true.
   */
  autoMode?: boolean | null;
  /** Whether to apply text normalization. */
  applyTextNormalization?: string | null;
  /** Strategy for timestamp transport ("ASYNC" or "SYNC"). Defaults to "ASYNC". */
  timestampTransportStrategy?: InworldTimestampTransportStrategy | null;
  /**
   * Runtime-updatable settings. Its given fields override the defaults
   * (model "inworld-tts-2", voice "Ashley").
   */
  settings?: InworldTTSSettings | null;
  /** How to aggregate text before synthesis. */
  textAggregationMode?: TextAggregationMode | null;
  /** Whether to append a trailing space to text before sending to TTS. Defaults to true. */
  appendTrailingSpace?: boolean;
}

/**
 * Inworld AI WebSocket-based TTS service.
 *
 * Uses bidirectional WebSocket for lower latency streaming. Supports multiple
 * independent audio contexts per connection (max 5). Outputs PCM audio with
 * word-level timestamps.
 */
export class InworldTTSService extends WebsocketTTSService {
  static Settings: typeof InworldTTSSettings = InworldTTSSettings;
  declare protected _settings: InworldTTSSettings;

  static {
    installTracedTts(InworldTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _url: string;
  protected _timestampType: string;
  protected _bufferSettings: {
    maxBufferDelayMs: number | null;
    bufferCharThreshold: number | null;
  };
  protected _receiveTask: Task<unknown> | null;
  // Track cumulative time across generations for monotonic timestamps within a turn.
  protected _cumulativeTime: number;
  // Track the end time of the last word in the current generation
  protected _generationEndTime: number;
  // Context IDs already sent to the server via _sendContext.
  protected _sentContextIds: Set<string>;
  // Fallback tracking for when timestamps are not received.
  protected _contextTexts: Map<string, string>;
  protected _contextsWithTimestamps: Set<string>;
  // Init-only config (not runtime-updatable).
  protected _audioEncoding: string;
  protected _audioSampleRate: number;
  protected _autoMode: boolean | null;
  protected _applyTextNormalization: string | null;
  protected _timestampTransportStrategy: InworldTimestampTransportStrategy | null;

  /**
   * Initialize the Inworld WebSocket TTS service.
   *
   * @param options.apiKey Inworld API key.
   * @param options.url URL of the Inworld WebSocket API.
   * @param options.sampleRate Audio sample rate in Hz.
   * @param options.encoding Audio encoding format.
   * @param options.autoMode Whether to use auto mode. When enabled, the
   *   server controls flushing of buffered text. Defaults to true.
   * @param options.applyTextNormalization Whether to apply text normalization.
   * @param options.timestampTransportStrategy Strategy for timestamp transport
   *   ("ASYNC" or "SYNC"). Defaults to "ASYNC".
   * @param options.settings Runtime-updatable settings.
   * @param options.textAggregationMode How to aggregate text before synthesis.
   * @param options.appendTrailingSpace Whether to append a trailing space to
   *   text before sending to TTS.
   *   Other options are passed to the parent class.
   */
  constructor(options: InworldTTSServiceOptions) {
    // Upstream derives autoMode from the deprecated aggregate_sentences when
    // it is not set; without it the default is true.
    const autoMode = options.autoMode ?? true;

    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = defaultInworldSettings(
      (new.target as typeof InworldTTSService).Settings,
    );

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushTextFrames: false,
      pushStopFrames: false,
      pauseFrameProcessing: true,
      sampleRate: options.sampleRate ?? null,
      textAggregationMode: options.textAggregationMode ?? null,
      appendTrailingSpace: options.appendTrailingSpace ?? true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._url = options.url ?? "wss://api.inworld.ai/tts/v1/voice:streamBidirectional";
    this._timestampType = "WORD";

    // Only the deprecated `params` set these upstream.
    this._bufferSettings = {
      maxBufferDelayMs: null,
      bufferCharThreshold: null,
    };

    this._receiveTask = null;

    // Track cumulative time across generations for monotonic timestamps within a turn.
    // When autoMode is enabled, the server controls generations and timestamps reset
    // to 0 after each generation, as indicated by a "flushCompleted" message. We
    // add _cumulativeTime to maintain monotonically increasing timestamps.
    this._cumulativeTime = 0.0;
    // Track the end time of the last word in the current generation
    this._generationEndTime = 0.0;

    // Context IDs already sent to the server via _sendContext, used to
    // make _sendContext idempotent so onTurnContextCreated can eagerly
    // open contexts without causing duplicate creates in runTts.
    this._sentContextIds = new Set();

    // Fallback tracking for when timestamps are not received. Without
    // timestamps, interruptions commit the full text rather than only the
    // portion that was spoken.
    this._contextTexts = new Map();
    this._contextsWithTimestamps = new Set();

    // Init-only config (not runtime-updatable).
    this._audioEncoding = options.encoding ?? "PCM";
    this._audioSampleRate = 0; // Set in setup()
    this._autoMode = autoMode;
    this._applyTextNormalization = options.applyTextNormalization ?? null;
    this._timestampTransportStrategy =
      options.timestampTransportStrategy === undefined
        ? "ASYNC"
        : options.timestampTransportStrategy;
  }

  /**
   * Render a pronunciation as IPA between slashes.
   *
   * See `formatInworldPronunciation`.
   *
   * @param word The word being pronounced.
   * @param ipa The pronunciation, in IPA.
   * @returns The IPA wrapped in slashes, or null when the pronunciation
   *   cannot be used.
   */
  static override formatPronunciation(word: string, ipa: string): string | null {
    return formatInworldPronunciation(word, ipa);
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Inworld WebSocket TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to Inworld language format.
   *
   * @param language The language to convert.
   * @returns The Inworld-specific BCP-47 language code, or null if not
   *   supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToInworldLanguage(language);
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    this._audioSampleRate = this.sampleRate;
    await this._connect();
  }

  /**
   * Flush any pending audio without closing the context.
   *
   * This triggers synthesis of all accumulated text in the buffer while
   * keeping the context open for subsequent text. The context is only closed
   * on interruption, disconnect, or end of session.
   */
  override async flushAudio(contextId: string | null = null): Promise<void> {
    const flushId = contextId || this.getActiveAudioContextId();
    if (flushId && this._websocket) {
      logger.trace(`Flushing audio for context ${flushId}`);
      await this._sendFlush(flushId);
    }
  }

  /** Reset the cumulative time and generation end time for a new generation. */
  protected _resetGenerationTiming(): void {
    this._cumulativeTime = 0.0;
    this._generationEndTime = 0.0;
  }

  /**
   * Eagerly open the context on the server when a new turn starts.
   *
   * This overlaps server-side context creation with sentence aggregation
   * time, so the context is ready by the time text arrives in runTts.
   */
  override async onTurnContextCreated(contextId: string): Promise<void> {
    try {
      await this._sendContext(contextId);
    } catch (e) {
      rethrowIfCancelled(e);
      logger.warning(`${this}: Failed to pre-open context: ${errorMessage(e)}`);
    }
  }

  /**
   * Calculate word timestamps from Inworld WebSocket API response.
   *
   * Adds cumulative time offset to maintain monotonically increasing
   * timestamps across multiple generations within an agent turn. Also tracks
   * the generation end time for updating cumulative time on flush.
   *
   * @param timestampInfo The timestamp information from Inworld API.
   * @returns List of [word, timestamp] tuples with cumulative offset applied.
   */
  protected _calculateWordTimes(timestampInfo: Dict): [string, number][] {
    const wordTimes: [string, number][] = [];

    const alignment = getDict(timestampInfo, "wordAlignment");
    const words: string[] = alignment.words ?? [];
    const startTimes: number[] = alignment.wordStartTimeSeconds ?? [];
    const endTimes: number[] = alignment.wordEndTimeSeconds ?? [];

    if (words.length > 0 && startTimes.length > 0 && words.length === startTimes.length) {
      words.forEach((word, i) => {
        const wordStart = this._cumulativeTime + (startTimes[i] as number);
        wordTimes.push([word, wordStart]);
      });

      // Track cumulative end time for this generation
      if (endTimes.length > 0) {
        this._generationEndTime = this._cumulativeTime + (endTimes.at(-1) as number);
      }

      logger.trace(
        `${this}: Word timestamps - raw_start_times=${pyJsonDumps(startTimes)}, ` +
          `cumulative_offset=${this._cumulativeTime}, ` +
          `adjusted_times=${pyJsonDumps(wordTimes.map(([, t]) => t))}, ` +
          `generation_end_time=${this._generationEndTime}`,
      );
    }

    return wordTimes;
  }

  protected async _closeContext(contextId: string | null): Promise<void> {
    if (!contextId) {
      return;
    }
    if (this._websocket) {
      logger.info(`${this}: Closing context ${contextId} due to interruption or completion`);
      try {
        await this._sendCloseContext(contextId);
      } catch (e) {
        rethrowIfCancelled(e);
        await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      }
    }
    this._sentContextIds.delete(contextId);
  }

  /**
   * Close the server-side context at end of turn.
   *
   * Sends close_context so contextClosed arrives immediately after the last
   * audio byte.
   */
  override async onTurnContextCompleted(): Promise<void> {
    const ctxId = this._turnContextId;
    await super.onTurnContextCompleted();
    await this._closeContext(ctxId);
  }

  /** Callback invoked when an audio context has been interrupted. */
  override async onAudioContextInterrupted(contextId: string): Promise<void> {
    await this._maybePushFallbackText(contextId);
    await this._closeContext(contextId);
    await super.onAudioContextInterrupted(contextId);
  }

  /**
   * Push the full text as fallback when no timestamps were received.
   *
   * so that the LLM conversation context still reflects what the agent
   * spoke. Without timestamps, the full text is always committed — even on
   * interruption — since there is no timing information to determine which
   * portion was actually spoken.
   */
  protected async _maybePushFallbackText(contextId: string | null): Promise<void> {
    if (!contextId) {
      return;
    }
    const hadTimestamps = this._contextsWithTimestamps.has(contextId);
    const text = (this._contextTexts.get(contextId) ?? "").trim();
    this._contextTexts.delete(contextId);
    this._contextsWithTimestamps.delete(contextId);
    if (hadTimestamps || !text) {
      return;
    }
    logger.debug(`${this}: No timestamps for context ${contextId}, pushing fallback: [${text}]`);
    const fallback = new TTSTextFrame({ text, textType: TextType.SENTENCE });
    fallback.contextId = contextId;
    const ctx = this._ttsContexts.get(contextId);
    fallback.appendToContext = ctx ? ctx.appendToContext : true;
    await this.pushFrame(fallback);
  }

  /**
   * Get the websocket for the Inworld WebSocket TTS service.
   *
   * @returns The websocket.
   */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Connect to the Inworld WebSocket TTS service. */
  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }

    if (this._websocket) {
      this._createKeepaliveTask(60);
    }
  }

  /** Disconnect from the Inworld WebSocket TTS service. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._cancelKeepaliveTask();

    await this._disconnectWebsocket();
  }

  /**
   * Apply a settings delta.
   *
   * Settings are stored but not applied to the active connection.
   */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length === 0) {
      return changed;
    }

    await this._disconnect();
    await this._connect();

    return changed;
  }

  /** Connect to the Inworld WebSocket TTS service. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      const requestId = crypto.randomUUID();
      logger.debug(`Connecting to Inworld WebSocket TTS (request_id=${requestId})`);
      const headers: Record<string, string> = {
        Authorization: `Basic ${this._apiKey}`,
        "X-User-Agent": USER_AGENT,
        "X-Request-Id": requestId,
      };
      this._websocket = await this._websocketConnect(this._url, { additionalHeaders: headers });
      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", errorMessage(e));
    }
  }

  /** Disconnect from the Inworld WebSocket TTS service. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug("Disconnecting from Inworld WebSocket TTS");
        const audioContexts = this.getAudioContexts();
        if (audioContexts.length > 0) {
          for (const ctxId of audioContexts) {
            await this._sendCloseContext(ctxId);
          }
        }
        await this._websocket.close();
        logger.debug("Disconnected from Inworld WebSocket TTS");
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      this._websocket = null;
      this._sentContextIds.clear();
      this._resetGenerationTiming();
      this._contextTexts.clear();
      this._contextsWithTimestamps.clear();
      await this._callEventHandler("on_disconnected");
    }
  }

  /** Handle incoming WebSocket messages from Inworld. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      let msg: Dict;
      try {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        msg = pyJsonLoads(text) as Dict;
      } catch (e) {
        // json.JSONDecodeError
        rethrowIfCancelled(e);
        logger.warning(`${this} received non-JSON message`);
        continue;
      }

      const result = getDict(msg, "result");
      const ctxId: string | null = result.contextId || result.context_id || null;

      // Log all incoming messages for debugging
      const msgTypes = ["contextCreated", "audioChunk", "flushCompleted", "contextClosed"].filter(
        (k) => k in result,
      );
      logger.trace(`${this}: Received message types=${msgTypes}, ctx_id=${ctxId}`);

      // Check for errors
      const status = getDict(result, "status");
      if ((status.code ?? 0) !== 0) {
        const errorMsg: string = status.message ?? "Unknown error";
        const errorCode = status.code;

        // Handle benign context errors:
        // - "Context not found" (code 5): keepalive sent after context expired
        // - "context_id is required" / "no open context": keepalive sent
        //   without an active context
        if (errorCode === 5 && errorMsg.toLowerCase().includes("not found")) {
          logger.debug(`${this}: Context ${ctxId} not found.`);
          continue;
        }
        const lowerErrorMsg = errorMsg.toLowerCase();
        if (
          lowerErrorMsg.includes("context_id is required") ||
          lowerErrorMsg.includes("no open context")
        ) {
          logger.debug(`${this}: Contextless message rejected (benign): ${errorMsg}`);
          continue;
        }

        // For other errors, push error frame
        await this.pushError(`Inworld API error: ${errorMsg}`);
        continue;
      }

      if (msg && typeof msg === "object" && "error" in msg) {
        const error = msg.error;
        await this.pushError(typeof error === "string" ? error : pyJsonDumps(error));
        continue;
      }

      // Handle context created confirmation
      if ("contextCreated" in result) {
        logger.trace(`${this}: Context created on server: ${ctxId}`);
      }

      // Process audio chunk
      const audioChunk = getDict(result, "audioChunk");
      const audioB64: string | undefined = audioChunk.audioContent;

      if (audioB64) {
        logger.trace(`${this}: Processing audio chunk for context ${ctxId}`);
        let audio = base64ToBytes(audioB64);
        if (hasWavHeader(audio)) {
          audio = audio.slice(44);
        }
        const frame = new TTSAudioRawFrame({
          audio,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId: ctxId,
        });

        if (ctxId) {
          await this.appendToAudioContext(ctxId, frame);
        }
      }

      // timestampInfo is inside audioChunk
      const timestampInfo = audioChunk.timestampInfo;
      if (timestampInfo) {
        const wordTimes = this._calculateWordTimes(timestampInfo);
        if (wordTimes.length > 0) {
          if (ctxId) {
            this._contextsWithTimestamps.add(ctxId);
          }
          await this.addWordTimestamps(wordTimes, ctxId, { preMergeTokens: true });
        }
      }

      // Handle flush completion, which indicates the end of a generation
      if ("flushCompleted" in result) {
        logger.trace(
          `${this}: Generation completed - updating cumulative_time: ` +
            `${this._cumulativeTime} -> ${this._generationEndTime}`,
        );
        this._cumulativeTime = this._generationEndTime;
      }

      // Handle context closed - context no longer exists on server
      if ("contextClosed" in result) {
        logger.debug(`${this}: Context closed on server: ${ctxId}`);
        await this._maybePushFallbackText(ctxId);
        await this.stopTtfbMetrics();
        await this.appendToAudioContext(ctxId, new TTSStoppedFrame({ contextId: ctxId }));
        await this.removeAudioContext(ctxId);
      }
    }
  }

  /** Send empty text, on the active context if there is one. */
  protected override async _sendKeepalive(): Promise<void> {
    const contextId = this.getActiveAudioContextId();
    let keepaliveMessage: Dict;
    if (contextId) {
      keepaliveMessage = {
        send_text: { text: "" },
        contextId,
      };
      logger.trace(`Sending keepalive for context ${contextId}`);
    } else {
      keepaliveMessage = { send_text: { text: "" } };
      logger.trace("Sending keepalive without context");
    }
    await this._getWebsocket().send(pyJsonDumps(keepaliveMessage));
  }

  /**
   * Send a context to the Inworld WebSocket TTS service.
   *
   * Idempotent: skips the send if this context was already opened on the
   * server (e.g., eagerly via onTurnContextCreated).
   *
   * @param contextId The context ID.
   */
  protected async _sendContext(contextId: string): Promise<void> {
    if (this._sentContextIds.has(contextId)) {
      return;
    }
    this._sentContextIds.add(contextId);

    const audioConfig: Dict = {
      audioEncoding: this._audioEncoding,
      sampleRateHertz: this._audioSampleRate,
    };
    const speakingRate = assertGiven(this._settings.speakingRate);
    if (speakingRate !== null) {
      audioConfig.speakingRate = speakingRate;
    }

    const createConfig: Dict = {
      voiceId: this._settings.voice,
      modelId: this._settings.model,
      audioConfig,
    };

    const temperature = assertGiven(this._settings.temperature);
    if (temperature !== null) {
      createConfig.temperature = temperature;
    }
    const deliveryMode = assertGiven(this._settings.deliveryMode);
    if (deliveryMode !== null) {
      createConfig.deliveryMode = deliveryMode;
    }
    const language = assertGiven(this._settings.language);
    if (language !== null) {
      createConfig.language = language;
    }
    if (this._applyTextNormalization !== null) {
      createConfig.applyTextNormalization = this._applyTextNormalization;
    }
    if (this._autoMode !== null) {
      createConfig.autoMode = this._autoMode;
    }
    if (this._timestampTransportStrategy !== null) {
      createConfig.timestampTransportStrategy = this._timestampTransportStrategy;
    }

    // Set buffer settings for timely audio generation.
    // Use provided values or defaults that work well for streaming LLM output.
    // (Upstream uses `or`, so 0 also takes the default.)
    createConfig.maxBufferDelayMs = this._bufferSettings.maxBufferDelayMs || 3000;
    createConfig.bufferCharThreshold = this._bufferSettings.bufferCharThreshold || 250;

    createConfig.timestampType = this._timestampType;

    const msg = { create: createConfig, contextId };
    logger.trace(`${this}: Sending context create: ${pyJsonDumps(createConfig)}`);
    await this.sendWithRetry(pyJsonDumps(msg), (error, options) =>
      this._reportError(error, options),
    );
  }

  /**
   * Send text to the Inworld WebSocket TTS service.
   *
   * @param contextId The context ID.
   * @param text The text to send.
   */
  protected async _sendText(contextId: string, text: string): Promise<void> {
    const msg = { send_text: { text }, contextId };
    await this.sendWithRetry(pyJsonDumps(msg), (error, options) =>
      this._reportError(error, options),
    );
  }

  /**
   * Send a flush to the Inworld WebSocket TTS service.
   *
   * @param contextId The context ID.
   */
  protected async _sendFlush(contextId: string): Promise<void> {
    const msg = { flush_context: {}, contextId };
    await this.sendWithRetry(pyJsonDumps(msg), (error, options) =>
      this._reportError(error, options),
    );
  }

  /**
   * Send a close context to the Inworld WebSocket TTS service.
   *
   * @param contextId The context ID.
   */
  protected async _sendCloseContext(contextId: string): Promise<void> {
    const msg = { close_context: {}, contextId };
    await this.sendWithRetry(pyJsonDumps(msg), (error, options) =>
      this._reportError(error, options),
    );
  }

  /**
   * Generate TTS audio for the given text using the Inworld WebSocket TTS
   * service.
   *
   * @param text The text to generate TTS audio for.
   * @param contextId Unique identifier for this TTS context.
   * @returns An asynchronous generator of frames.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    logger.debug(`${this}: Generating WebSocket TTS [${text}, for context: ${contextId}]`);

    try {
      if (!this._websocket || this._websocket.state === State.CLOSED) {
        await this._connect();
      }

      if (this._websocket === null) {
        logger.warning(`${this}: websocket unavailable after connect attempt, skipping TTS`);
        yield new ErrorFrame({ error: "websocket unavailable" });
        return;
      }

      try {
        if (!this.audioContextAvailable(contextId)) {
          this._resetGenerationTiming();
          await this.createAudioContext(contextId);
          await this.startTtfbMetrics();
          yield new TTSStartedFrame({ contextId });
          await this._sendContext(contextId);
        }

        this._contextTexts.set(contextId, (this._contextTexts.get(contextId) ?? "") + text);

        await this._sendText(contextId, text);
        await this.startTtsUsageMetrics(text);
      } catch (e) {
        rethrowIfCancelled(e);
        yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
        yield new TTSStoppedFrame({ contextId });
        return;
      }
      yield null;
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}
