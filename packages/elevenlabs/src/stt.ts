// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/elevenlabs/stt.py

/**
 * ElevenLabs speech-to-text service implementation.
 *
 * This module provides integration with ElevenLabs' Speech-to-Text API for
 * transcription using segmented audio processing. The service uploads audio
 * files and receives transcription results directly.
 *
 * Porting notes:
 * - `ElevenLabsSTTService` uploads with `fetch` and `FormData`. DIVERGENCE:
 *   upstream's required `aiohttp_session` becomes an optional `fetch` option
 *   (the global `fetch` by default).
 * - `ElevenLabsRealtimeSTTService` uses the global `WebSocket` through
 *   `WebsocketService._websocketConnect()`. The `xi-api-key` header is sent on
 *   the opening handshake: by the Bun, Node and Deno `WebSocket`, and on
 *   Cloudflare Workers through `fetch`, which `websocketConnect` uses there.
 * - Deprecated APIs are not ported: `ElevenLabsSTTService.InputParams`,
 *   `ElevenLabsRealtimeSTTService.InputParams` and the `model` and `params`
 *   constructor options.
 */

import { abortable, currentSignal, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { FrameDirection, FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import {
  ELEVENLABS_REALTIME_TTFS_P99,
  ELEVENLABS_TTFS_P99,
} from "@pipedog/core/services/stt_latency";
import {
  SegmentedSTTService,
  type SegmentedSTTServiceOptions,
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { State, type WebsocketClientConnection } from "@pipedog/core/services/websocket_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { isGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python `urllib.parse.quote_plus` (what `urlencode` applies to each key and value). */
function quotePlus(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%20", "+");
}

const LANGUAGE_MAP: Partial<Record<Language, string>> = {
  [Language.AF]: "afr", // Afrikaans
  [Language.AM]: "amh", // Amharic
  [Language.AR]: "ara", // Arabic
  [Language.HY]: "hye", // Armenian
  [Language.AS]: "asm", // Assamese
  [Language.AST]: "ast", // Asturian
  [Language.AZ]: "aze", // Azerbaijani
  [Language.BE]: "bel", // Belarusian
  [Language.BN]: "ben", // Bengali
  [Language.BS]: "bos", // Bosnian
  [Language.BG]: "bul", // Bulgarian
  [Language.MY]: "mya", // Burmese
  [Language.YUE]: "yue", // Cantonese
  [Language.CA]: "cat", // Catalan
  [Language.CEB]: "ceb", // Cebuano
  [Language.NY]: "nya", // Chichewa
  [Language.HR]: "hrv", // Croatian
  [Language.CS]: "ces", // Czech
  [Language.DA]: "dan", // Danish
  [Language.NL]: "nld", // Dutch
  [Language.EN]: "eng", // English
  [Language.ET]: "est", // Estonian
  [Language.FIL]: "fil", // Filipino
  [Language.FI]: "fin", // Finnish
  [Language.FR]: "fra", // French
  [Language.FF]: "ful", // Fulah
  [Language.GL]: "glg", // Galician
  [Language.LG]: "lug", // Ganda
  [Language.KA]: "kat", // Georgian
  [Language.DE]: "deu", // German
  [Language.EL]: "ell", // Greek
  [Language.GU]: "guj", // Gujarati
  [Language.HA]: "hau", // Hausa
  [Language.HE]: "heb", // Hebrew
  [Language.HI]: "hin", // Hindi
  [Language.HU]: "hun", // Hungarian
  [Language.IS]: "isl", // Icelandic
  [Language.IG]: "ibo", // Igbo
  [Language.ID]: "ind", // Indonesian
  [Language.GA]: "gle", // Irish
  [Language.IT]: "ita", // Italian
  [Language.JA]: "jpn", // Japanese
  [Language.JV]: "jav", // Javanese
  [Language.KEA]: "kea", // Kabuverdianu
  [Language.KN]: "kan", // Kannada
  [Language.KK]: "kaz", // Kazakh
  [Language.KM]: "khm", // Khmer
  [Language.KO]: "kor", // Korean
  [Language.KU]: "kur", // Kurdish
  [Language.KY]: "kir", // Kyrgyz
  [Language.LO]: "lao", // Lao
  [Language.LV]: "lav", // Latvian
  [Language.LN]: "lin", // Lingala
  [Language.LT]: "lit", // Lithuanian
  [Language.LUO]: "luo", // Luo
  [Language.LB]: "ltz", // Luxembourgish
  [Language.MK]: "mkd", // Macedonian
  [Language.MS]: "msa", // Malay
  [Language.ML]: "mal", // Malayalam
  [Language.MT]: "mlt", // Maltese
  [Language.ZH]: "zho", // Mandarin Chinese
  [Language.MI]: "mri", // Māori
  [Language.MR]: "mar", // Marathi
  [Language.MN]: "mon", // Mongolian
  [Language.NE]: "nep", // Nepali
  [Language.NSO]: "nso", // Northern Sotho
  [Language.NO]: "nor", // Norwegian
  [Language.OC]: "oci", // Occitan
  [Language.OR]: "ori", // Odia
  [Language.PS]: "pus", // Pashto
  [Language.FA]: "fas", // Persian
  [Language.PL]: "pol", // Polish
  [Language.PT]: "por", // Portuguese
  [Language.PA]: "pan", // Punjabi
  [Language.RO]: "ron", // Romanian
  [Language.RU]: "rus", // Russian
  [Language.SR]: "srp", // Serbian
  [Language.SN]: "sna", // Shona
  [Language.SD]: "snd", // Sindhi
  [Language.SK]: "slk", // Slovak
  [Language.SL]: "slv", // Slovenian
  [Language.SO]: "som", // Somali
  [Language.ES]: "spa", // Spanish
  [Language.SW]: "swa", // Swahili
  [Language.SV]: "swe", // Swedish
  [Language.TA]: "tam", // Tamil
  [Language.TG]: "tgk", // Tajik
  [Language.TE]: "tel", // Telugu
  [Language.TH]: "tha", // Thai
  [Language.TR]: "tur", // Turkish
  [Language.UK]: "ukr", // Ukrainian
  [Language.UMB]: "umb", // Umbundu
  [Language.UR]: "urd", // Urdu
  [Language.UZ]: "uzb", // Uzbek
  [Language.VI]: "vie", // Vietnamese
  [Language.CY]: "cym", // Welsh
  [Language.WO]: "wol", // Wolof
  [Language.XH]: "xho", // Xhosa
  [Language.ZU]: "zul", // Zulu
};

/**
 * Convert a Language value to ElevenLabs language code.
 *
 * Source: https://elevenlabs.io/docs/capabilities/speech-to-text
 *
 * @param language The Language value to convert.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to its base language's code (`en-US`
 *   becomes `eng`) and logs a warning (via
 *   `resolveLanguage(..., useBaseCode = true)`).
 */
export function languageToElevenlabsLanguage(language: Language): string {
  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/** Commit strategies for transcript segmentation. */
export const CommitStrategy = {
  MANUAL: "manual",
  VAD: "vad",
} as const;
export type CommitStrategy = (typeof CommitStrategy)[keyof typeof CommitStrategy];

export interface ElevenLabsSTTSettingsOptions extends STTSettingsOptions {
  /**
   * Whether to include audio events like (laughter), (coughing) in the
   * transcription.
   */
  tagAudioEvents?: boolean | null | NotGiven;
  /** List of key terms or phrases to bias transcription towards. */
  keyterms?: string[] | null | NotGiven;
  /**
   * Whether to drop filler words, false starts and non-speech sounds from the
   * transcript. Supported by `scribe_v2` only.
   */
  noVerbatim?: boolean | null | NotGiven;
}

/**
 * Settings for ElevenLabsSTTService.
 *
 * - `tagAudioEvents`: whether to include audio events like (laughter),
 *   (coughing) in the transcription.
 * - `keyterms`: list of key terms or phrases to bias transcription towards.
 * - `noVerbatim`: whether to drop filler words, false starts and non-speech
 *   sounds from the transcript. Supported by `scribe_v2` only.
 */
export class ElevenLabsSTTSettings extends STTSettings {
  tagAudioEvents: boolean | null | NotGiven = NOT_GIVEN;
  keyterms: string[] | null | NotGiven = NOT_GIVEN;
  noVerbatim: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: ElevenLabsSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface ElevenLabsRealtimeSTTSettingsOptions extends STTSettingsOptions {
  /** List of key terms or phrases to bias transcription towards. */
  keyterms?: string[] | null | NotGiven;
  /**
   * Whether to drop filler words, false starts and non-speech sounds from the
   * transcript.
   */
  noVerbatim?: boolean | null | NotGiven;
  /** Seconds of silence before VAD commits (0.3-3.0). */
  vadSilenceThresholdSecs?: number | null | NotGiven;
  /** VAD sensitivity (0.1-0.9, lower is more sensitive). */
  vadThreshold?: number | null | NotGiven;
  /** Minimum speech duration for VAD (50-2000ms). */
  minSpeechDurationMs?: number | null | NotGiven;
  /** Minimum silence duration for VAD (50-2000ms). */
  minSilenceDurationMs?: number | null | NotGiven;
  /** Whether ElevenLabs filters out background audio before transcription. */
  filterBackgroundAudio?: boolean | null | NotGiven;
}

/**
 * Settings for ElevenLabsRealtimeSTTService.
 *
 * - `keyterms`: list of key terms or phrases to bias transcription towards.
 * - `noVerbatim`: whether to drop filler words, false starts and non-speech
 *   sounds from the transcript.
 * - `vadSilenceThresholdSecs`: seconds of silence before VAD commits
 *   (0.3-3.0). Only used with `CommitStrategy.VAD`; null uses the ElevenLabs
 *   default.
 * - `vadThreshold`: VAD sensitivity (0.1-0.9, lower is more sensitive). Only
 *   used with `CommitStrategy.VAD`.
 * - `minSpeechDurationMs`: minimum speech duration for VAD (50-2000ms). Only
 *   used with `CommitStrategy.VAD`.
 * - `minSilenceDurationMs`: minimum silence duration for VAD (50-2000ms). Only
 *   used with `CommitStrategy.VAD`.
 * - `filterBackgroundAudio`: whether ElevenLabs filters out background audio
 *   before transcription.
 */
export class ElevenLabsRealtimeSTTSettings extends STTSettings {
  keyterms: string[] | null | NotGiven = NOT_GIVEN;
  noVerbatim: boolean | null | NotGiven = NOT_GIVEN;
  vadSilenceThresholdSecs: number | null | NotGiven = NOT_GIVEN;
  vadThreshold: number | null | NotGiven = NOT_GIVEN;
  minSpeechDurationMs: number | null | NotGiven = NOT_GIVEN;
  minSilenceDurationMs: number | null | NotGiven = NOT_GIVEN;
  filterBackgroundAudio: boolean | null | NotGiven = NOT_GIVEN;

  constructor(options: ElevenLabsRealtimeSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface ElevenLabsSTTServiceOptions extends SegmentedSTTServiceOptions {
  /** ElevenLabs API key for authentication. */
  apiKey: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces upstream's required `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Base URL for ElevenLabs API. Defaults to "https://api.elevenlabs.io". */
  baseUrl?: string;
  /**
   * Runtime-updatable settings. Its given fields override the defaults
   * (model "scribe_v2", language English).
   */
  settings?: ElevenLabsSTTSettings | null;
}

/**
 * Speech-to-text service using ElevenLabs' file-based API.
 *
 * This service uses ElevenLabs' Speech-to-Text API to perform transcription
 * on audio segments. It inherits from SegmentedSTTService to handle audio
 * buffering and speech detection. The service uploads audio files to
 * ElevenLabs and receives transcription results directly.
 */
export class ElevenLabsSTTService extends SegmentedSTTService {
  static Settings: typeof ElevenLabsSTTSettings = ElevenLabsSTTSettings;
  declare protected _settings: ElevenLabsSTTSettings;

  static {
    installTracedStt(ElevenLabsSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _fetch: typeof fetch;

  /**
   * Initialize the ElevenLabs STT service.
   *
   * @param options.apiKey ElevenLabs API key for authentication.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an aiohttp
   *   ClientSession).
   * @param options.baseUrl Base URL for ElevenLabs API.
   * @param options.sampleRate Audio sample rate in Hz. If not provided, uses
   *   the pipeline's rate.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to SegmentedSTTService.
   */
  constructor(options: ElevenLabsSTTServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof ElevenLabsSTTService).Settings({
      model: "scribe_v2",
      language: Language.EN,
      tagAudioEvents: null,
      keyterms: null,
      noVerbatim: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? ELEVENLABS_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "https://api.elevenlabs.io";
    this._fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Check if the service can generate processing metrics.
   *
   * @returns True, as ElevenLabs STT service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to ElevenLabs service-specific language code.
   *
   * @param language The language to convert.
   * @returns The ElevenLabs-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToElevenlabsLanguage(language);
  }

  /**
   * Upload audio data to ElevenLabs and get transcription result.
   *
   * @param audioData Raw audio bytes in WAV format.
   * @returns The transcription result data.
   * @throws Error If transcription fails or returns an error.
   */
  protected async _transcribeAudio(audioData: Uint8Array): Promise<Dict> {
    const url = `${this._baseUrl}/v1/speech-to-text`;
    const headers = { "xi-api-key": this._apiKey };

    // Create form data with the audio file
    const data = new FormData();
    data.append(
      "file",
      new Blob([audioData as Uint8Array<ArrayBuffer>], { type: "audio/x-wav" }),
      "audio.wav",
    );

    // Add required model_id and language_code
    data.append("model_id", String(this._settings.model));
    if (this._settings.language) {
      data.append("language_code", String(this._settings.language));
    }
    if (this._settings.tagAudioEvents !== null) {
      data.append("tag_audio_events", String(this._settings.tagAudioEvents).toLowerCase());
    }
    const keyterms = this._settings.keyterms;
    if (isGiven(keyterms) && keyterms !== null) {
      for (const keyterm of keyterms) {
        data.append("keyterms", keyterm);
      }
    }
    const noVerbatim = this._settings.noVerbatim;
    if (isGiven(noVerbatim) && noVerbatim !== null) {
      data.append("no_verbatim", String(noVerbatim).toLowerCase());
    }

    const response = await abortable(
      this._fetch(url, { method: "POST", body: data, headers, signal: currentSignal() }),
    );
    if (response.status !== 200) {
      const errorText = await abortable(response.text());
      logger.error(`ElevenLabs transcription error: ${errorText}`);
      throw new Error(`Transcription failed with status ${response.status}: ${errorText}`);
    }

    const result = (await abortable(response.json())) as Dict;
    return result;
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: string | null = null,
  ): Promise<void> {
    await this.stopProcessingMetrics();
  }

  /**
   * Transcribe an audio segment using ElevenLabs' STT API.
   *
   * The audio is already in WAV format from the SegmentedSTTService. Only
   * non-empty transcriptions are yielded.
   *
   * @param audio Raw audio bytes in WAV format (already converted by base
   *   class).
   * @yields TranscriptionFrame containing the transcribed text, or ErrorFrame
   *   on failure.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    try {
      await this.startProcessingMetrics();

      // Upload audio and get transcription result directly
      const result = await this._transcribeAudio(audio);

      // Extract transcription text
      const text = String(result.text ?? "").trim();
      if (text) {
        // Use the language_code returned by the API
        const detectedLanguage: string | null =
          "language_code" in result ? result.language_code : "eng";

        await this._handleTranscription(text, true, detectedLanguage);
        logger.debug(`Transcription: [${text}]`);

        yield new TranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          language: detectedLanguage as Language | null,
          result,
        });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }
}

/**
 * Get the appropriate audio format string for a given sample rate.
 *
 * @param sampleRate The audio sample rate in Hz.
 * @returns The ElevenLabs audio format string.
 */
export function audioFormatFromSampleRate(sampleRate: number): string {
  switch (sampleRate) {
    case 8000:
      return "pcm_8000";
    case 16000:
      return "pcm_16000";
    case 22050:
      return "pcm_22050";
    case 24000:
      return "pcm_24000";
    case 44100:
      return "pcm_44100";
    case 48000:
      return "pcm_48000";
  }
  logger.warning(
    `ElevenLabsRealtimeSTTService: No audio format available for ${sampleRate} sample rate, using pcm_16000`,
  );
  return "pcm_16000";
}

export interface ElevenLabsRealtimeSTTServiceOptions extends WebsocketSTTServiceOptions {
  /** ElevenLabs API key for authentication. */
  apiKey: string;
  /** Base URL for ElevenLabs WebSocket API. Defaults to "api.elevenlabs.io". */
  baseUrl?: string;
  /**
   * How to segment speech — `CommitStrategy.MANUAL` (Pipecat VAD) or
   * `CommitStrategy.VAD` (ElevenLabs VAD). Defaults to `CommitStrategy.MANUAL`.
   */
  commitStrategy?: CommitStrategy;
  /** Whether to include word-level timestamps in transcripts. */
  includeTimestamps?: boolean;
  /** Whether to enable logging on ElevenLabs' side. */
  enableLogging?: boolean;
  /** Whether to include language detection in transcripts. */
  includeLanguageDetection?: boolean;
  /**
   * Runtime-updatable settings. Its given fields override the defaults
   * (model "scribe_v2_realtime", language auto-detected).
   */
  settings?: ElevenLabsRealtimeSTTSettings | null;
}

/**
 * Speech-to-text service using ElevenLabs' Realtime WebSocket API.
 *
 * This service uses ElevenLabs' Realtime Speech-to-Text API to perform
 * transcription with ultra-low latency. It supports both partial (interim) and
 * committed (final) transcripts, and can use either manual commit control or
 * automatic Voice Activity Detection (VAD) for segment boundaries.
 *
 * By default, uses manual commit strategy where Pipecat's VAD controls when
 * to commit transcript segments, providing consistency with other STT
 * services.
 */
export class ElevenLabsRealtimeSTTService extends WebsocketSTTService {
  static Settings: typeof ElevenLabsRealtimeSTTSettings = ElevenLabsRealtimeSTTSettings;
  declare protected _settings: ElevenLabsRealtimeSTTSettings;

  static {
    installTracedStt(ElevenLabsRealtimeSTTService.prototype, "_handleTranscription");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _audioFormat: string;
  protected _receiveTask: Task<unknown> | null;
  protected _commitStrategy: CommitStrategy;
  protected _includeTimestamps: boolean;
  protected _enableLogging: boolean;
  protected _includeLanguageDetection: boolean;

  /**
   * Initialize the ElevenLabs Realtime STT service.
   *
   * @param options.apiKey ElevenLabs API key for authentication.
   * @param options.baseUrl Base URL for ElevenLabs WebSocket API.
   * @param options.commitStrategy How to segment speech —
   *   `CommitStrategy.MANUAL` (Pipecat VAD) or `CommitStrategy.VAD`
   *   (ElevenLabs VAD). Defaults to `CommitStrategy.MANUAL`.
   * @param options.sampleRate Audio sample rate in Hz. If not provided, uses
   *   the pipeline's rate.
   * @param options.includeTimestamps Whether to include word-level timestamps
   *   in transcripts.
   * @param options.enableLogging Whether to enable logging on ElevenLabs'
   *   side.
   * @param options.includeLanguageDetection Whether to include language
   *   detection in transcripts.
   * @param options.settings Runtime-updatable settings.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to WebsocketSTTService.
   */
  constructor(options: ElevenLabsRealtimeSTTServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof ElevenLabsRealtimeSTTService).Settings({
      model: "scribe_v2_realtime",
      language: null,
      vadSilenceThresholdSecs: null,
      vadThreshold: null,
      minSpeechDurationMs: null,
      minSilenceDurationMs: null,
      keyterms: null,
      noVerbatim: null,
      filterBackgroundAudio: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined
          ? ELEVENLABS_REALTIME_TTFS_P99
          : options.ttfsP99Latency,
      keepaliveTimeout: 10,
      keepaliveInterval: 5,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "api.elevenlabs.io";
    this._audioFormat = ""; // initialized in setup()
    this._receiveTask = null;

    // Init-only config (not runtime-updatable).
    this._commitStrategy = options.commitStrategy ?? CommitStrategy.MANUAL;
    this._includeTimestamps = options.includeTimestamps ?? false;
    this._enableLogging = options.enableLogging ?? false;
    this._includeLanguageDetection = options.includeLanguageDetection ?? false;
  }

  /**
   * Check if the service can generate processing metrics.
   *
   * @returns True, as ElevenLabs Realtime STT service supports metrics
   *   generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language value to ElevenLabs service-specific language code.
   *
   * @param language The language to convert.
   * @returns The ElevenLabs-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToElevenlabsLanguage(language);
  }

  /**
   * Apply a settings delta and reconnect if anything changed.
   *
   * @param delta An STTSettings (or `ElevenLabsRealtimeSTTService.Settings`)
   *   delta.
   * @returns Record mapping changed field names to their previous values.
   */
  protected override async _updateSettings(delta: STTSettings): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);

    if (Object.keys(changed).length === 0) {
      return changed;
    }

    if (this._websocket) {
      await this._disconnect();
      await this._connect();
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
    this._audioFormat = audioFormatFromSampleRate(this.sampleRate);
    await this._connect();
  }

  /**
   * Process incoming frames and handle speech events.
   *
   * @param frame The frame to process.
   * @param direction Direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof VADUserStoppedSpeakingFrame) {
      // Send commit when user stops speaking (manual commit mode)
      if (this._commitStrategy === CommitStrategy.MANUAL) {
        if (this._websocket && this._websocket.state === State.OPEN) {
          try {
            const commitMessage = {
              message_type: "input_audio_chunk",
              audio_base_64: "",
              commit: true,
              sample_rate: this.sampleRate,
            };
            await this._websocket.send(pyJsonDumps(commitMessage));
            logger.trace("Sent manual commit to ElevenLabs");
          } catch (e) {
            rethrowIfCancelled(e);
            logger.warning(`Failed to send commit: ${errorMessage(e)}`);
          }
        }
      }
    }
  }

  /**
   * Process audio data for speech-to-text transcription.
   *
   * @param audio Raw audio bytes to transcribe.
   * @yields null - transcription results are handled via WebSocket responses.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    // The receive loop reconnects a dropped socket; audio arriving meanwhile
    // is dropped.
    if (this._websocket && this._websocket.state === State.OPEN) {
      let error: unknown = null;
      try {
        // Encode audio as base64
        const audioBase64 = bytesToBase64(audio);

        // Send audio chunk
        const message = {
          message_type: "input_audio_chunk",
          audio_base_64: audioBase64,
          commit: false,
          sample_rate: this.sampleRate,
        };
        await this._websocket.send(pyJsonDumps(message));
      } catch (e) {
        rethrowIfCancelled(e);
        error = e;
      }
      if (error !== null) {
        yield new ErrorFrame({ error: `ElevenLabs Realtime STT error: ${errorMessage(error)}` });
      }
    }

    yield null;
  }

  /** Establish WebSocket connection to ElevenLabs Realtime STT. */
  override async _connect(): Promise<void> {
    await this._connectWebsocket();

    await super._connect();

    // Started even when the connection failed: with no socket the receive
    // loop goes straight to its reconnect path, which retries the connect.
    if (!this._receiveTask) {
      this._receiveTask = this.createTask(() =>
        this._receiveTaskHandler((error, options) => this._reportError(error, options)),
      );
    }
  }

  /** Close WebSocket connection and cleanup tasks. */
  override async _disconnect(): Promise<void> {
    await super._disconnect();

    if (this._receiveTask) {
      await this.cancelTask(this._receiveTask);
      this._receiveTask = null;
    }

    await this._disconnectWebsocket();
  }

  /**
   * Send silent audio wrapped in ElevenLabs' JSON protocol.
   *
   * @param silence Silent 16-bit mono PCM audio bytes.
   */
  protected override async _sendKeepalive(silence: Uint8Array): Promise<void> {
    if (this._websocket === null) {
      // should never happen — caller should gate on _isKeepaliveReady()
      return;
    }
    const audioBase64 = bytesToBase64(silence);
    const message = {
      message_type: "input_audio_chunk",
      audio_base_64: audioBase64,
      commit: false,
      sample_rate: this.sampleRate,
    };
    await this._websocket.send(pyJsonDumps(message));
  }

  /** Connect to ElevenLabs Realtime STT WebSocket endpoint. */
  override async _connectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        return;
      }

      logger.debug("Connecting to ElevenLabs Realtime STT");

      // Build query parameters
      const params = [`model_id=${this._settings.model}`];

      if (this._settings.language) {
        params.push(`language_code=${this._settings.language}`);
      }

      params.push(`audio_format=${this._audioFormat}`);
      params.push(`commit_strategy=${this._commitStrategy}`);

      const keyterms = this._settings.keyterms;
      if (isGiven(keyterms) && keyterms !== null) {
        for (const keyterm of keyterms) {
          params.push(`keyterms=${quotePlus(keyterm)}`);
        }
      }

      const noVerbatim = this._settings.noVerbatim;
      if (isGiven(noVerbatim) && noVerbatim !== null) {
        params.push(`no_verbatim=${String(noVerbatim).toLowerCase()}`);
      }

      // Add optional parameters
      if (this._includeTimestamps) {
        params.push(`include_timestamps=${String(this._includeTimestamps).toLowerCase()}`);
      }

      if (this._enableLogging) {
        params.push(`enable_logging=${String(this._enableLogging).toLowerCase()}`);
      }

      if (this._includeLanguageDetection) {
        params.push(
          `include_language_detection=${String(this._includeLanguageDetection).toLowerCase()}`,
        );
      }

      // Add VAD parameters if using VAD commit strategy and values are specified
      if (this._commitStrategy === CommitStrategy.VAD) {
        if (this._settings.vadSilenceThresholdSecs !== null) {
          params.push(`vad_silence_threshold_secs=${this._settings.vadSilenceThresholdSecs}`);
        }
        if (this._settings.vadThreshold !== null) {
          params.push(`vad_threshold=${this._settings.vadThreshold}`);
        }
        if (this._settings.minSpeechDurationMs !== null) {
          params.push(`min_speech_duration_ms=${this._settings.minSpeechDurationMs}`);
        }
        if (this._settings.minSilenceDurationMs !== null) {
          params.push(`min_silence_duration_ms=${this._settings.minSilenceDurationMs}`);
        }
      }

      const filterBackgroundAudio = this._settings.filterBackgroundAudio;
      if (isGiven(filterBackgroundAudio) && filterBackgroundAudio !== null) {
        params.push(`filter_background_audio=${String(filterBackgroundAudio).toLowerCase()}`);
      }

      const wsUrl = `wss://${this._baseUrl}/v1/speech-to-text/realtime?${params.join("&")}`;

      const headers = { "xi-api-key": this._apiKey };

      this._websocket = await this._websocketConnect(wsUrl, { additionalHeaders: headers });
      await this._callEventHandler("on_connected");
      logger.debug("Connected to ElevenLabs Realtime STT");
    } catch (e) {
      rethrowIfCancelled(e);
      this._websocket = null;
      await this.pushError(`Unable to connect to ElevenLabs Realtime STT: ${errorMessage(e)}`, {
        exception: e,
      });
    }
  }

  /** Disconnect from ElevenLabs Realtime STT WebSocket. */
  override async _disconnectWebsocket(): Promise<void> {
    try {
      if (this._websocket && this._websocket.state === State.OPEN) {
        logger.debug("Disconnecting from ElevenLabs Realtime STT");
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

  /**
   * Get the current WebSocket connection.
   *
   * @returns The WebSocket connection.
   * @throws Error If WebSocket is not connected.
   */
  protected _getWebsocket(): WebsocketClientConnection {
    if (this._websocket) {
      return this._websocket;
    }
    throw new Error("Websocket not connected");
  }

  /** Continuously receive and process WebSocket messages. */
  override async _receiveMessages(): Promise<void> {
    for await (const message of this._getWebsocket()) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      try {
        let data: Dict;
        try {
          data = pyJsonLoads(text) as Dict;
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`Received non-JSON message: ${text}`);
          continue;
        }
        await this._processResponse(data);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`Error processing message: ${errorMessage(e)}`);
      }
      // Connection closed, will reconnect on next audio chunk
    }
  }

  /**
   * Process a response message from ElevenLabs.
   *
   * @param data Parsed JSON response data.
   */
  protected async _processResponse(data: Dict): Promise<void> {
    const messageType = data.message_type;

    if (messageType === "session_started") {
      logger.debug(`ElevenLabs session started: ${pyJsonDumps(data)}`);
    } else if (messageType === "partial_transcript") {
      await this._onPartialTranscript(data);
    } else if (messageType === "committed_transcript") {
      await this._onCommittedTranscript(data);
    } else if (messageType === "committed_transcript_with_timestamps") {
      await this._onCommittedTranscriptWithTimestamps(data);
    } else if (
      [
        "error",
        "auth_error",
        "quota_exceeded",
        "transcriber_error",
        "input_error",
        "invalid_request",
        "commit_throttled",
        "unaccepted_terms",
        "rate_limited",
        "queue_overflow",
        "resource_exhausted",
        "session_time_limit_exceeded",
        "chunk_size_exceeded",
        "insufficient_audio_activity",
      ].includes(messageType)
    ) {
      const errorMsg = "error" in data ? data.error : `Unknown error - ${messageType}`;
      await this.pushError(`Error: ${errorMsg}`);
    } else {
      logger.debug(`Unknown message type: ${messageType}`);
    }
  }

  /**
   * Handle partial transcript (interim results).
   *
   * @param data Partial transcript data.
   */
  protected async _onPartialTranscript(data: Dict): Promise<void> {
    const text = String(data.text ?? "").trim();
    if (!text) {
      return;
    }

    // Get language if provided
    const language = data.language_code ?? null;

    logger.trace(`Partial transcript: [${text}]`);

    await this.pushFrame(
      new InterimTranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
        result: data,
      }),
    );
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: string | null = null,
  ): Promise<void> {}

  /**
   * Handle committed transcript (final results).
   *
   * @param data Committed transcript data.
   */
  protected async _onCommittedTranscript(data: Dict): Promise<void> {
    // The server pairs every commit with a committed_transcript_with_timestamps
    // message whenever timestamps or language detection is enabled, and only
    // that message carries language_code. Skip this one so each commit is
    // emitted once.
    if (this._includeTimestamps || this._includeLanguageDetection) {
      return;
    }

    const text = String(data.text ?? "").trim();
    if (!text) {
      return;
    }

    // Get language if provided
    const language = data.language_code ?? null;

    logger.debug(`Committed transcript: [${text}]`);

    await this._handleTranscription(text, true, language);

    const finalized = this._commitStrategy === CommitStrategy.MANUAL;

    // Report usage before the transcription frame so tracing can attach it to
    // the STT span the frame closes.
    await this.emitSttUsageMetrics();
    await this.pushFrame(
      new TranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
        result: data,
        finalized,
      }),
    );
  }

  /**
   * Handle committed transcript with word-level timestamps.
   *
   * This message is sent when include_timestamps=true or
   * include_language_detection=true. The result data includes:
   *
   * - text: The transcribed text
   * - language_code: Detected language (if available)
   * - words: Array of word objects with timing information, null when only
   *   language detection was requested:
   *   - text: The word text
   *   - start: Start time in seconds
   *   - end: End time in seconds
   *   - type: "word" or "spacing"
   *   - speaker_id: Speaker identifier (if available)
   *   - logprob: Log probability score (if available)
   *   - characters: Array of character strings (if available)
   *
   * @param data Committed transcript data with timestamps.
   */
  protected async _onCommittedTranscriptWithTimestamps(data: Dict): Promise<void> {
    const text = String(data.text ?? "").trim();
    if (!text) {
      return;
    }

    // Get language if provided
    const language = data.language_code ?? null;

    logger.debug(`Committed transcript with timestamps: [${text}]`);

    await this._handleTranscription(text, true, language);

    const finalized = this._commitStrategy === CommitStrategy.MANUAL;

    await this.emitSttUsageMetrics();
    await this.pushFrame(
      new TranscriptionFrame({
        text,
        userId: this._userId,
        timestamp: timeNowIso8601(),
        language,
        result: data,
        finalized,
      }),
    );
  }
}
