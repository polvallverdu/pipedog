// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/sarvam/tts.py

/**
 * Sarvam AI text-to-speech service implementation.
 *
 * This module provides TTS services using Sarvam AI's API with support for
 * multiple Indian languages:
 *
 * **Model Variants:**
 *
 * - **bulbul:v3** (default): Sarvam's current TTS model, with temperature control
 *   - Does NOT support: pitch, loudness
 *   - Supports: pace (0.5-2.0), temperature (0.01-1.0)
 *   - Default sample rate: 24000 Hz
 *   - Preprocessing is always enabled
 *   - Speakers: shubh (default), aditya, ritu, priya, neha, rahul, pooja, rohan,
 *     simran, kavya, amit, dev, ishita, shreya, ratan, varun, manan, sumit, roopa,
 *     kabir, aayan, ashutosh, advait
 *
 * - **bulbul:v4-flash**: Low-latency TTS model
 *   - Supports: pitch, loudness, pace (0.5-2.0)
 *   - Does NOT support: temperature
 *   - Default sample rate: 24000 Hz
 *   - Preprocessing is always enabled
 *   - Speakers: its own catalogue, listed in Sarvam's docs; the bulbul:v3 names
 *     are not accepted
 *
 * See https://docs.sarvam.ai/api-reference-docs/text-to-speech/stream for full
 * API details.
 *
 * Wire format: upstream's code, cross-checked against the `sarvamai` npm SDK
 * (v1.1.12) types for the WebSocket `config`, `text`, `flush`, `ping`,
 * `audio`, `event` and `error` messages, and the `/text-to-speech` REST body.
 *
 * Porting notes:
 * - Deprecated upstream APIs are not ported: the `InputParams` classes and the
 *   `model`, `voice_id`, `params` and `aggregate_sentences` constructor
 *   arguments (use `settings` and `textAggregationMode`). The deprecated
 *   `bulbul:v2` model (`SarvamTTSModel.BULBUL_V2`, `SarvamTTSSpeakerV2` and its
 *   model config) is dropped too, so selecting it raises "Unsupported model".
 * - `SarvamHttpTTSService` uses `fetch`. Upstream's `aiohttp_session` becomes
 *   an optional `fetch` function (defaults to the global `fetch`).
 * - The WebSocket connects through `WebsocketService._websocketConnect()` (the
 *   core `websocketConnect`), sending `api-subscription-key` and `User-Agent`
 *   on the opening handshake.
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
import { assertGiven, isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { sdkHeaders } from "./_sdk.ts";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Available Sarvam TTS models.
 *
 * - `BULBUL_V3_BETA`: Pre-GA tag of the v3 model.
 * - `BULBUL_V3`: Current TTS model, with temperature control. Does NOT support
 *   pitch/loudness. Pace range 0.5-2.0. Default sample rate 24000 Hz.
 *   Preprocessing is always enabled.
 * - `BULBUL_V4_FLASH`: Low-latency TTS model, with its own speaker catalogue.
 *   Supports pitch/loudness. Pace range 0.5-2.0. Does NOT support temperature.
 *   Default sample rate 24000 Hz. Preprocessing is always enabled.
 *
 * Upstream's deprecated `BULBUL_V2` is not ported.
 */
export const SarvamTTSModel = {
  BULBUL_V3_BETA: "bulbul:v3-beta",
  BULBUL_V3: "bulbul:v3",
  BULBUL_V4_FLASH: "bulbul:v4-flash",
} as const;
export type SarvamTTSModel = (typeof SarvamTTSModel)[keyof typeof SarvamTTSModel];

/**
 * Available speakers for the bulbul:v3 model.
 *
 * Includes a wider variety of voices with different characteristics.
 */
export const SarvamTTSSpeakerV3 = {
  ADITYA: "aditya",
  RITU: "ritu",
  PRIYA: "priya",
  NEHA: "neha",
  RAHUL: "rahul",
  POOJA: "pooja",
  ROHAN: "rohan",
  SIMRAN: "simran",
  KAVYA: "kavya",
  AMIT: "amit",
  DEV: "dev",
  ISHITA: "ishita",
  SHREYA: "shreya",
  RATAN: "ratan",
  VARUN: "varun",
  MANAN: "manan",
  SUMIT: "sumit",
  ROOPA: "roopa",
  KABIR: "kabir",
  AAYAN: "aayan",
  SHUBH: "shubh",
  ASHUTOSH: "ashutosh",
  ADVAIT: "advait",
  AMELIA: "amelia",
  SOPHIA: "sophia",
} as const;
export type SarvamTTSSpeakerV3 = (typeof SarvamTTSSpeakerV3)[keyof typeof SarvamTTSSpeakerV3];

export interface TTSModelConfigOptions {
  /** Whether the model accepts pitch parameter. */
  supportsPitch: boolean;
  /** Whether the model accepts loudness parameter. */
  supportsLoudness: boolean;
  /** Whether the model accepts temperature parameter. */
  supportsTemperature: boolean;
  /** Default audio sample rate in Hz. */
  defaultSampleRate: number;
  /** Default speaker voice ID. */
  defaultSpeaker: string;
  /** Valid range for pace parameter (min, max). */
  paceRange: readonly [number, number];
  /** Whether preprocessing is always enabled. */
  preprocessingAlwaysEnabled: boolean;
  /** Available speaker names for this model. */
  speakers: readonly string[];
}

/** Immutable configuration for a Sarvam TTS model. */
export class TTSModelConfig {
  readonly supportsPitch: boolean;
  readonly supportsLoudness: boolean;
  readonly supportsTemperature: boolean;
  readonly defaultSampleRate: number;
  readonly defaultSpeaker: string;
  readonly paceRange: readonly [number, number];
  readonly preprocessingAlwaysEnabled: boolean;
  readonly speakers: readonly string[];

  constructor(options: TTSModelConfigOptions) {
    this.supportsPitch = options.supportsPitch;
    this.supportsLoudness = options.supportsLoudness;
    this.supportsTemperature = options.supportsTemperature;
    this.defaultSampleRate = options.defaultSampleRate;
    this.defaultSpeaker = options.defaultSpeaker;
    this.paceRange = options.paceRange;
    this.preprocessingAlwaysEnabled = options.preprocessingAlwaysEnabled;
    this.speakers = options.speakers;
    Object.freeze(this);
  }
}

export const TTS_MODEL_CONFIGS: Readonly<Record<string, TTSModelConfig>> = {
  "bulbul:v3-beta": new TTSModelConfig({
    supportsPitch: false,
    supportsLoudness: false,
    supportsTemperature: true,
    defaultSampleRate: 24000,
    defaultSpeaker: "shubh",
    paceRange: [0.5, 2.0],
    preprocessingAlwaysEnabled: true,
    speakers: Object.values(SarvamTTSSpeakerV3),
  }),
  "bulbul:v3": new TTSModelConfig({
    supportsPitch: false,
    supportsLoudness: false,
    supportsTemperature: true,
    defaultSampleRate: 24000,
    defaultSpeaker: "shubh",
    paceRange: [0.5, 2.0],
    preprocessingAlwaysEnabled: true,
    speakers: Object.values(SarvamTTSSpeakerV3),
  }),
  "bulbul:v4-flash": new TTSModelConfig({
    supportsPitch: true,
    supportsLoudness: true,
    supportsTemperature: false,
    defaultSampleRate: 24000,
    defaultSpeaker: "shubh_en_narration_gentle",
    paceRange: [0.5, 2.0],
    preprocessingAlwaysEnabled: true,
    // Empty rather than a catalogue: this model's speakers come from Sarvam's
    // docs, and its API rejects an unknown one with the list it accepts.
    speakers: [],
  }),
};

function modelConfig(model: unknown): TTSModelConfig | undefined {
  return typeof model === "string" && Object.hasOwn(TTS_MODEL_CONFIGS, model)
    ? TTS_MODEL_CONFIGS[model]
    : undefined;
}

/**
 * Get the list of available speakers for a given model.
 *
 * @param model The model name (e.g., "bulbul:v3").
 * @returns List of speaker names available for the model.
 */
export function getSpeakersForModel(model: string): string[] {
  const config = modelConfig(model);
  if (config) {
    return [...config.speakers];
  }
  // Default to v3 speakers for unknown models
  return [...TTS_MODEL_CONFIGS["bulbul:v3"]!.speakers];
}

/**
 * Convert Pipecat Language enum to Sarvam AI language codes.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the full language code string and
 *   logs a warning (via `resolveLanguage(..., false)`).
 */
export function languageToSarvamLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.BN]: "bn-IN", // Bengali
    [Language.BN_IN]: "bn-IN",
    [Language.EN]: "en-IN", // English (India)
    [Language.EN_IN]: "en-IN",
    [Language.GU]: "gu-IN", // Gujarati
    [Language.GU_IN]: "gu-IN",
    [Language.HI]: "hi-IN", // Hindi
    [Language.HI_IN]: "hi-IN",
    [Language.KN]: "kn-IN", // Kannada
    [Language.KN_IN]: "kn-IN",
    [Language.ML]: "ml-IN", // Malayalam
    [Language.ML_IN]: "ml-IN",
    [Language.MR]: "mr-IN", // Marathi
    [Language.MR_IN]: "mr-IN",
    [Language.OR]: "od-IN", // Odia
    [Language.OR_IN]: "od-IN",
    [Language.PA]: "pa-IN", // Punjabi
    [Language.PA_IN]: "pa-IN",
    [Language.TA]: "ta-IN", // Tamil
    [Language.TA_IN]: "ta-IN",
    [Language.TE]: "te-IN", // Telugu
    [Language.TE_IN]: "te-IN",
  };

  return resolveLanguage(language, LANGUAGE_MAP, false);
}

export interface SarvamHttpTTSSettingsOptions extends TTSSettingsOptions {
  /**
   * Whether to enable text preprocessing. Defaults to false. Always enabled
   * for bulbul:v3 and bulbul:v4-flash (cannot be disabled).
   */
  enablePreprocessing?: boolean | null | NotGiven;
  /** Speech pace multiplier, 0.5 to 2.0. Defaults to 1.0. */
  pace?: number | null | NotGiven;
  /**
   * Voice pitch adjustment. Defaults to 0.0. Supported by bulbul:v4-flash;
   * ignored by bulbul:v3.
   */
  pitch?: number | null | NotGiven;
  /**
   * Volume multiplier. Defaults to 1.0. Supported by bulbul:v4-flash; ignored
   * by bulbul:v3.
   */
  loudness?: number | null | NotGiven;
  /**
   * Controls output randomness (0.01 to 1.0). Lower values = more
   * deterministic, higher = more random. Defaults to 0.6. Supported by
   * bulbul:v3; ignored by bulbul:v4-flash.
   */
  temperature?: number | null | NotGiven;
}

/** Settings for SarvamHttpTTSService. See `SarvamHttpTTSSettingsOptions`. */
export class SarvamHttpTTSSettings extends TTSSettings {
  enablePreprocessing: boolean | null | NotGiven = NOT_GIVEN;
  pace: number | null | NotGiven = NOT_GIVEN;
  pitch: number | null | NotGiven = NOT_GIVEN;
  loudness: number | null | NotGiven = NOT_GIVEN;
  temperature: number | null | NotGiven = NOT_GIVEN;

  constructor(options: SarvamHttpTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface SarvamTTSSettingsOptions extends SarvamHttpTTSSettingsOptions {
  /**
   * Minimum characters to buffer before generating audio. Lower values reduce
   * latency but may affect quality. Defaults to 50.
   */
  minBufferSize?: number | null | NotGiven;
  /**
   * Maximum characters processed in a single chunk. Controls memory usage and
   * processing efficiency. Defaults to 150.
   */
  maxChunkLength?: number | null | NotGiven;
}

/**
 * Settings for SarvamTTSService.
 *
 * Extends `SarvamHttpTTSSettings` with WebSocket-specific buffering parameters.
 */
export class SarvamTTSSettings extends SarvamHttpTTSSettings {
  minBufferSize: number | null | NotGiven = NOT_GIVEN;
  maxChunkLength: number | null | NotGiven = NOT_GIVEN;

  static override _aliases: Record<string, string> = { target_language_code: "language" };

  constructor(options: SarvamTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/**
 * Resolve the model config, apply sample-rate/voice defaults and clamp or drop
 * settings the model doesn't support. Shared by both services' constructors.
 */
function prepareSettings(
  defaultSettings: SarvamHttpTTSSettings,
  userSettings: SarvamHttpTTSSettings | null | undefined,
  sampleRate: number | null | undefined,
): { config: TTSModelConfig; sampleRate: number; model: string } {
  // Get model configuration (validates model exists)
  const resolvedModel = assertGiven(defaultSettings.model);
  const config = modelConfig(resolvedModel);
  if (resolvedModel === null || config === undefined) {
    const allowed = Object.keys(TTS_MODEL_CONFIGS).sort().join(", ");
    throw new Error(`Unsupported model '${resolvedModel}'. Allowed values: ${allowed}.`);
  }

  // Set default sample rate based on model if not specified
  const effectiveSampleRate = sampleRate ?? config.defaultSampleRate;

  // Set default voice based on model if not specified via any mechanism
  if (userSettings === null || userSettings === undefined || !isGiven(userSettings.voice)) {
    defaultSettings.voice = config.defaultSpeaker;
  }

  // Validate and clamp pace to model's valid range
  const pace = assertGiven(defaultSettings.pace);
  const [paceMin, paceMax] = config.paceRange;
  if (pace !== null && (pace < paceMin || pace > paceMax)) {
    logger.warning(`Pace ${pace} is outside model range (${paceMin}-${paceMax}). Clamping.`);
    defaultSettings.pace = Math.max(paceMin, Math.min(paceMax, pace));
  }

  // Force preprocessing for models that require it
  if (config.preprocessingAlwaysEnabled) {
    defaultSettings.enablePreprocessing = true;
  }

  // Warn about unsupported model-specific parameters
  const pitch = defaultSettings.pitch;
  if (!config.supportsPitch && pitch !== null && pitch !== 0) {
    logger.warning(`pitch parameter is ignored for ${resolvedModel}`);
    defaultSettings.pitch = null;
  }
  const loudness = defaultSettings.loudness;
  if (!config.supportsLoudness && loudness !== null && loudness !== 1) {
    logger.warning(`loudness parameter is ignored for ${resolvedModel}`);
    defaultSettings.loudness = null;
  }
  const temperature = defaultSettings.temperature;
  if (!config.supportsTemperature && temperature !== null && temperature !== 0.6) {
    logger.warning(`temperature parameter is ignored for ${resolvedModel}`);
    defaultSettings.temperature = null;
  }

  return { config, sampleRate: effectiveSampleRate, model: resolvedModel };
}

export interface SarvamHttpTTSServiceOptions extends TTSServiceOptions {
  /** Sarvam AI API subscription key. */
  apiKey: string;
  /** Sarvam AI API base URL. Defaults to "https://api.sarvam.ai". */
  baseUrl?: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream takes a shared `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Runtime-updatable settings. */
  settings?: SarvamHttpTTSSettings | null;
}

/**
 * Text-to-Speech service using Sarvam AI's API.
 *
 * Converts text to speech using Sarvam AI's TTS models with support for
 * multiple Indian languages. Provides control over voice characteristics.
 *
 * **Models:**
 *
 * - **bulbul:v3** (default): no pitch/loudness (ignored), pace 0.5 to 2.0,
 *   temperature 0.01 to 1.0, 24000 Hz, preprocessing always enabled.
 * - **bulbul:v4-flash**: pitch, loudness and pace (0.5 to 2.0); no temperature
 *   (ignored); 24000 Hz; its own speaker catalogue.
 *
 * @example
 * ```ts
 * // Using bulbul:v3 (default) with temperature control
 * const tts = new SarvamHttpTTSService({
 *   apiKey: "your-api-key",
 *   settings: new SarvamHttpTTSService.Settings({
 *     voice: "shubh",
 *     model: "bulbul:v3",
 *     language: Language.HI,
 *     pace: 1.2, // Range: 0.5-2.0 for v3
 *     temperature: 0.8,
 *   }),
 * });
 * ```
 */
export class SarvamHttpTTSService extends TTSService {
  static Settings: typeof SarvamHttpTTSSettings = SarvamHttpTTSSettings;
  declare protected _settings: SarvamHttpTTSSettings;

  static {
    installTracedTts(SarvamHttpTTSService.prototype, "runTts");
  }

  protected _config: TTSModelConfig;
  protected _apiKey: string;
  protected _baseUrl: string;
  protected _fetch: typeof fetch;

  /**
   * Initialize the Sarvam TTS service.
   *
   * @param options.apiKey Sarvam AI API subscription key.
   * @param options.baseUrl Sarvam AI API base URL. Defaults to
   *   "https://api.sarvam.ai".
   * @param options.sampleRate Audio sample rate in Hz (8000, 16000, 22050,
   *   24000, and, for bulbul:v3, 32000, 44100, 48000). If null, uses the
   *   model-specific default.
   * @param options.fetch `fetch` used for HTTP requests (upstream: a shared
   *   aiohttp session).
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "bulbul:v3", voice "shubh", language
   *   "en-IN").
   *   Other options are passed to `TTSService`.
   */
  constructor(options: SarvamHttpTTSServiceOptions) {
    const cls = new.target as typeof SarvamHttpTTSService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "bulbul:v3",
      voice: "shubh",
      language: "en-IN",
      enablePreprocessing: false,
      pace: 1.0,
      pitch: null,
      loudness: null,
      temperature: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const prepared = prepareSettings(defaultSettings, options.settings, options.sampleRate);

    super({
      ...options,
      sampleRate: prepared.sampleRate,
      pushStopFrames: true,
      pushStartFrame: true,
      settings: defaultSettings,
    });

    this._config = prepared.config;
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "https://api.sarvam.ai";
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Sarvam service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Sarvam AI language format.
   *
   * @param language The language to convert.
   * @returns The Sarvam AI-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToSarvamLanguage(language);
  }

  /** Apply a settings delta, switching to the new model's capabilities on a model change. */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if ("model" in changed) {
      const config = modelConfig(assertGiven(this._settings.model) || "");
      if (config === undefined) {
        logger.warning(`Unsupported model '${this._settings.model}', ignoring`);
        this._settings.model = changed.model as string | null;
        delete changed.model;
        this._syncModelNameToMetrics();
      } else {
        this._config = config;
        if (!("voice" in changed)) {
          this._settings.voice = config.defaultSpeaker;
        }
      }
    }

    return changed;
  }

  /**
   * Generate speech from text using Sarvam AI's API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @yields Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      // Build payload with common parameters
      const payload: Dict = {
        text,
        target_language_code: this._settings.language,
        speaker: this._settings.voice,
        speech_sample_rate: this.sampleRate,
        enable_preprocessing: this._settings.enablePreprocessing,
        model: this._settings.model,
        pace: this._settings.pace !== null ? this._settings.pace : 1.0,
      };

      // Add model-specific parameters based on config
      if (this._config.supportsPitch) {
        payload.pitch = this._settings.pitch !== null ? this._settings.pitch : 0.0;
      }
      if (this._config.supportsLoudness) {
        payload.loudness = this._settings.loudness !== null ? this._settings.loudness : 1.0;
      }
      if (this._config.supportsTemperature) {
        payload.temperature =
          this._settings.temperature !== null ? this._settings.temperature : 0.6;
      }

      const headers = {
        "api-subscription-key": this._apiKey,
        "Content-Type": "application/json",
        ...sdkHeaders(),
      };

      const url = `${this._baseUrl}/text-to-speech`;

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
        yield new ErrorFrame({ error: `Sarvam API error: ${errorText}` });
        return;
      }

      const responseData = (await abortable(response.json())) as Dict;

      await this.startTtsUsageMetrics(text);

      // Decode base64 audio data
      if (!("audios" in responseData) || !responseData.audios || responseData.audios.length === 0) {
        yield new ErrorFrame({ error: "No audio data received" });
        return;
      }

      // Get the first audio (there should be only one for single text input)
      const base64Audio: string = responseData.audios[0];
      let audioData = base64ToBytes(base64Audio);

      // Strip WAV header (first 44 bytes) if present
      if (
        audioData.length > 44 &&
        audioData[0] === 0x52 && // R
        audioData[1] === 0x49 && // I
        audioData[2] === 0x46 && // F
        audioData[3] === 0x46 //   F
      ) {
        logger.debug("Stripping WAV header from Sarvam audio data");
        audioData = audioData.subarray(44);
      }

      yield new TTSAudioRawFrame({
        audio: audioData,
        sampleRate: this.sampleRate,
        numChannels: 1,
        contextId,
      });
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Error generating TTS: ${errorMessage(e)}`, exception: e });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}

export interface SarvamTTSServiceOptions extends InterruptibleTTSServiceOptions {
  /** Sarvam API key for authenticating TTS requests. */
  apiKey: string;
  /** WebSocket URL for the TTS backend (default production URL). */
  url?: string;
  /** Runtime-updatable settings. */
  settings?: SarvamTTSSettings | null;
}

/**
 * WebSocket-based text-to-speech service using Sarvam AI.
 *
 * Provides streaming TTS with real-time audio generation for multiple Indian
 * languages. Uses WebSocket for low-latency streaming audio synthesis. See
 * `SarvamHttpTTSService` for the models and their capabilities.
 *
 * **WebSocket Protocol:**
 * The service uses a WebSocket connection for real-time streaming. Messages
 * include:
 * - config: Initial configuration with voice settings
 * - text: Text chunks for synthesis
 * - flush: Signal to process remaining buffered text
 * - ping: Keepalive signal
 *
 * @example
 * ```ts
 * // Using bulbul:v3 (default) with temperature control
 * const tts = new SarvamTTSService({
 *   apiKey: "your-api-key",
 *   settings: new SarvamTTSService.Settings({
 *     voice: "shubh",
 *     model: "bulbul:v3",
 *     language: Language.HI,
 *     pace: 1.2, // Range: 0.5-2.0 for v3
 *     temperature: 0.8,
 *   }),
 * });
 * ```
 *
 * See https://docs.sarvam.ai/api-reference-docs/text-to-speech/stream for API details.
 */
export class SarvamTTSService extends InterruptibleTTSService {
  static Settings: typeof SarvamTTSSettings = SarvamTTSSettings;
  declare protected _settings: SarvamTTSSettings;

  static {
    installTracedTts(SarvamTTSService.prototype, "runTts");
  }

  protected _config: TTSModelConfig;
  protected _speechSampleRate: string;
  protected _outputAudioCodec: string;
  protected _outputAudioBitrate: string;
  protected _url: string;
  protected _websocketUrl: string;
  protected _apiKey: string;
  protected _receiveTask: Task<unknown> | null = null;

  /**
   * Initialize the Sarvam TTS service with voice and transport configuration.
   *
   * @param options.apiKey Sarvam API key for authenticating TTS requests.
   * @param options.url WebSocket URL for the TTS backend (default production URL).
   * @param options.textAggregationMode How to aggregate text before synthesis.
   * @param options.sampleRate Output audio sample rate in Hz (8000, 16000,
   *   22050, 24000). If null, uses the model-specific default.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "bulbul:v3", voice "shubh", language
   *   "en-IN", min buffer 50, max chunk length 150).
   *   Other options are passed to `InterruptibleTTSService`.
   *
   * See https://docs.sarvam.ai/api-reference-docs/text-to-speech/stream
   */
  constructor(options: SarvamTTSServiceOptions) {
    const cls = new.target as typeof SarvamTTSService;

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new cls.Settings({
      model: "bulbul:v3",
      voice: "shubh",
      language: "en-IN",
      enablePreprocessing: false,
      minBufferSize: 50,
      maxChunkLength: 150,
      pace: 1.0,
      pitch: null,
      loudness: null,
      temperature: null,
    });

    // Init-only audio format fields (not runtime-updatable)
    const outputAudioCodec = "linear16";
    const outputAudioBitrate = "128k";

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    const prepared = prepareSettings(defaultSettings, options.settings, options.sampleRate);

    super({
      ...options,
      pushTextFrames: true,
      pauseFrameProcessing: true,
      pushStopFrames: true,
      pushStartFrame: true,
      sampleRate: prepared.sampleRate,
      settings: defaultSettings,
    });

    this._config = prepared.config;

    // Init-only audio format fields (not runtime-updatable)
    this._speechSampleRate = String(prepared.sampleRate);
    this._outputAudioCodec = outputAudioCodec;
    this._outputAudioBitrate = outputAudioBitrate;

    // WebSocket endpoint URL with model query parameter. We explicitly request
    // the completion event so we can emit TTSStoppedFrame as soon as synthesis
    // finishes, rather than waiting for the stop_frame_timeout_s idle timer.
    this._url = options.url ?? "wss://api.sarvam.ai/text-to-speech/ws";
    this._websocketUrl = `${this._url}?model=${prepared.model}&send_completion_event=true`;
    this._apiKey = options.apiKey;

    this._receiveTask = null;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Sarvam service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Sarvam AI language format.
   *
   * @param language The language to convert.
   * @returns The Sarvam AI-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToSarvamLanguage(language);
  }

  /**
   * Set up the service and connect.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    // WebSocket API expects sample rate as string
    this._speechSampleRate = String(this.sampleRate);
    await this._connect();
  }

  /** Flush any pending audio synthesis by sending flush command. */
  override async flushAudio(_contextId: string | null = null): Promise<void> {
    try {
      if (this._websocket) {
        const msg = { type: "flush" };
        await this._websocket.send(pyJsonDumps(msg));
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error sending flush to Sarvam: ${errorMessage(e)}`, { exception: e });
    }
  }

  /** Apply a settings delta, reconnecting on a model change and resending config otherwise. */
  protected override async _updateSettings(delta: TTSSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if ("model" in changed) {
      const config = modelConfig(assertGiven(this._settings.model) || "");
      if (config === undefined) {
        logger.warning(`Unsupported model '${this._settings.model}', ignoring`);
        this._settings.model = changed.model as string | null;
        delete changed.model;
        this._syncModelNameToMetrics();
      } else {
        this._config = config;
        if (!("voice" in changed)) {
          this._settings.voice = config.defaultSpeaker;
        }
        // The model is a URL query parameter, so a new model needs a new connection.
        this._websocketUrl = `${this._url}?model=${this._settings.model}&send_completion_event=true`;
        await this._disconnect();
        await this._connect();
        return changed;
      }
    }

    if (Object.keys(changed).length > 0) {
      await this._sendConfig();
    }

    return changed;
  }

  /** Connect to Sarvam WebSocket and start background tasks. */
  override async _connect(): Promise<void> {
    await super._connect();

    await this._connectWebsocket();

    if (this._websocket && !this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }

    if (this._websocket) {
      this._createKeepaliveTask(20);
    }
  }

  /** Disconnect from Sarvam WebSocket and clean up tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._cancelKeepaliveTask();

    await this._disconnectWebsocket();
  }

  /** Establish WebSocket connection to Sarvam API. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      const wsAdditionalHeaders = {
        "api-subscription-key": this._apiKey,
        ...sdkHeaders(),
      };

      this._websocket = await this._websocketConnect(this._websocketUrl, {
        additionalHeaders: wsAdditionalHeaders,
      });
      logger.debug("Connected to Sarvam TTS Websocket");
      await this._sendConfig();

      await this._callEventHandler("on_connected");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error connecting to Sarvam TTS Websocket: ${errorMessage(e)}`, {
        exception: e,
      });
      this._websocket = null;
      await this._callEventHandler("on_connection_error", `${errorMessage(e)}`);
    }
  }

  /** Send initial configuration message. */
  async _sendConfig(): Promise<void> {
    if (!this._websocket) {
      throw new Error("WebSocket not connected");
    }
    // Build config dict for the API
    const configData: Dict = {
      target_language_code: this._settings.language,
      speaker: this._settings.voice,
      speech_sample_rate: this._speechSampleRate,
      enable_preprocessing: this._settings.enablePreprocessing,
      min_buffer_size: this._settings.minBufferSize,
      max_chunk_length: this._settings.maxChunkLength,
      output_audio_codec: this._outputAudioCodec,
      output_audio_bitrate: this._outputAudioBitrate,
      pace: this._settings.pace,
      model: this._settings.model,
    };
    if (this._config.supportsPitch && this._settings.pitch !== null) {
      configData.pitch = this._settings.pitch;
    }
    if (this._config.supportsLoudness && this._settings.loudness !== null) {
      configData.loudness = this._settings.loudness;
    }
    if (this._config.supportsTemperature && this._settings.temperature !== null) {
      configData.temperature = this._settings.temperature;
    }
    logger.debug(`Config being sent is ${pyJsonDumps(configData)}`);
    const configMessage = { type: "config", data: configData };

    try {
      await this._websocket.send(pyJsonDumps(configMessage));
      logger.debug("Configuration sent successfully");
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
      throw e;
    }
  }

  /** Close WebSocket connection and clean up state. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      await this.stopAllMetrics();

      if (this._websocket) {
        logger.debug("Disconnecting from Sarvam");
        await this._websocket.close();
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Error closing websocket: ${errorMessage(e)}`, { exception: e });
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

  /** Receive and process messages from Sarvam WebSocket. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      if (typeof message === "string") {
        const msg = pyJsonLoads(message) as Dict;
        const contextId = this.getActiveAudioContextId();
        if (msg.type === "audio") {
          const requestId = msg.data?.request_id ?? "N/A";
          logger.trace(`TTS request_id=${requestId}, context_id=${contextId}`);

          // Check for interruption before processing audio
          await this.stopTtfbMetrics();
          const audio = base64ToBytes(msg.data.audio);
          const frame = new TTSAudioRawFrame({
            audio,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId,
          });
          await this.appendToAudioContext(contextId, frame);
        } else if (msg.type === "event" && msg.data?.event_type === "final") {
          // Synthesis for the active context is complete. Emit the
          // TTSStoppedFrame immediately so BotStoppedSpeakingFrame tracks
          // the end of audio, instead of waiting on stop_frame_timeout_s.
          logger.trace(`TTS final event for context_id=${contextId}`);
          if (contextId && this.audioContextAvailable(contextId)) {
            await this.appendToAudioContext(contextId, new TTSStoppedFrame({ contextId }));
            await this.removeAudioContext(contextId);
          }
        } else if (msg.type === "error") {
          const errorMsg: string = msg.data.message;
          await this.pushError(`TTS Error: ${errorMsg}`);

          // If it's a timeout error, the connection might need to be reset
          if (
            errorMsg.toLowerCase().includes("too long") ||
            errorMsg.toLowerCase().includes("timeout")
          ) {
            logger.warning("Connection timeout detected, service may need restart");
          }
          await this.appendToAudioContext(
            contextId,
            new ErrorFrame({ error: `TTS Error: ${errorMsg}` }),
          );
        }
      }
    }
  }

  /** Send a ping to keep the connection open through silences. */
  protected override async _sendKeepalive(): Promise<void> {
    await this._getWebsocket().send(pyJsonDumps({ type: "ping" }));
  }

  /** Send text to Sarvam WebSocket for synthesis. */
  protected async _sendText(text: string): Promise<void> {
    if (this._websocket && this._websocket.state === State.OPEN) {
      const msg = { type: "text", data: { text } };
      await this._websocket.send(pyJsonDumps(msg));
    } else {
      logger.warning("WebSocket not ready, cannot send text");
    }
  }

  /**
   * Generate speech audio frames from input text using Sarvam TTS.
   *
   * Sends text over WebSocket for synthesis and yields corresponding audio or
   * status frames.
   *
   * @param text The text input to synthesize.
   * @param contextId The context ID for tracking audio frames.
   * @yields Frame objects including TTSStartedFrame, TTSAudioRawFrame(s), or TTSStoppedFrame.
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
