// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/whisper/base_stt.py

/**
 * Base class for Whisper-based speech-to-text services.
 *
 * This module provides common functionality for services implementing the Whisper API
 * interface, including language mapping, metrics generation, and error handling.
 *
 * Porting notes:
 * - The deprecated constructor arguments `model`, `language`, `prompt` and
 *   `temperature` are not ported (upstream removes them in 2.0.0). Use
 *   `settings` instead.
 * - The HTTP client is the OpenAI JS SDK's `fetch` option (upstream takes an
 *   httpx client, so `Timeout` and connection limits do not carry over).
 * - `_requires_api_key` is a static, so a subclass can override it before the
 *   base constructor runs.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { ErrorFrame, type Frame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import { STTSettings, type STTSettingsOptions } from "@pipedog/core/services/settings";
import { WHISPER_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import {
  SegmentedSTTService,
  type SegmentedSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import { installTracedStt } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import OpenAI from "openai";
import type { Transcription } from "openai/resources/audio/transcriptions";

export type { Transcription };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Settings for BaseWhisperSTTService.
 *
 * - `prompt`: optional text to guide the model's style or continue a previous
 *   segment.
 * - `temperature`: sampling temperature between 0 and 1.
 */
export interface BaseWhisperSTTSettingsOptions extends STTSettingsOptions {
  /** Optional text to guide the model's style or continue a previous segment. */
  prompt?: string | null | NotGiven;
  /** Sampling temperature between 0 and 1. */
  temperature?: number | null | NotGiven;
}

/**
 * Settings for BaseWhisperSTTService.
 *
 * - `prompt`: optional text to guide the model's style or continue a previous
 *   segment.
 * - `temperature`: sampling temperature between 0 and 1.
 */
export class BaseWhisperSTTSettings extends STTSettings {
  prompt: string | null | NotGiven = NOT_GIVEN;
  temperature: number | null | NotGiven = NOT_GIVEN;

  constructor(options: BaseWhisperSTTSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/**
 * Maps pipecat Language enum to Whisper API language codes.
 *
 * Language support for Whisper API.
 * Docs: https://platform.openai.com/docs/guides/speech-to-text#supported-languages
 *
 * @param language A Language value representing the input language.
 * @returns The corresponding service language code. If `language` is not in
 *   the verified mapping, falls back to the base language code (e.g. `en` from
 *   `en-US`) and logs a warning (via `resolveLanguage(..., useBaseCode=true)`).
 */
export function languageToWhisperLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.AF]: "af",
    [Language.AR]: "ar",
    [Language.HY]: "hy",
    [Language.AZ]: "az",
    [Language.BE]: "be",
    [Language.BS]: "bs",
    [Language.BG]: "bg",
    [Language.CA]: "ca",
    [Language.ZH]: "zh",
    [Language.HR]: "hr",
    [Language.CS]: "cs",
    [Language.DA]: "da",
    [Language.NL]: "nl",
    [Language.EN]: "en",
    [Language.ET]: "et",
    [Language.FI]: "fi",
    [Language.FR]: "fr",
    [Language.GL]: "gl",
    [Language.DE]: "de",
    [Language.EL]: "el",
    [Language.HE]: "he",
    [Language.HI]: "hi",
    [Language.HU]: "hu",
    [Language.IS]: "is",
    [Language.ID]: "id",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.KN]: "kn",
    [Language.KK]: "kk",
    [Language.KO]: "ko",
    [Language.LV]: "lv",
    [Language.LT]: "lt",
    [Language.MK]: "mk",
    [Language.MS]: "ms",
    [Language.MR]: "mr",
    [Language.MI]: "mi",
    [Language.NE]: "ne",
    [Language.NO]: "no",
    [Language.FA]: "fa",
    [Language.PL]: "pl",
    [Language.PT]: "pt",
    [Language.RO]: "ro",
    [Language.RU]: "ru",
    [Language.SR]: "sr",
    [Language.SK]: "sk",
    [Language.SL]: "sl",
    [Language.ES]: "es",
    [Language.SW]: "sw",
    [Language.SV]: "sv",
    [Language.TL]: "tl",
    [Language.TA]: "ta",
    [Language.TH]: "th",
    [Language.TR]: "tr",
    [Language.UK]: "uk",
    [Language.UR]: "ur",
    [Language.VI]: "vi",
    [Language.CY]: "cy",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/**
 * Options for BaseWhisperSTTService.
 *
 * - `apiKey`: service API key. Defaults to null.
 * - `baseUrl`: service API base URL. Defaults to null.
 * - `httpClient`: custom `fetch` for API requests, e.g. one with a longer
 *   request timeout. Defaults to null, which lets the SDK use the global fetch.
 * - `includeProbMetrics`: if true, enables probability metrics in the API
 *   response. Each service implements this differently. Defaults to false.
 * - `pushEmptyTranscripts`: if true, allow empty `TranscriptionFrame` frames to
 *   be pushed downstream instead of discarding them. Defaults to false.
 * - `settings`: runtime-updatable settings.
 * - `ttfsP99Latency`: P99 latency from speech end to final transcript in
 *   seconds.
 *
 * Other options are passed to SegmentedSTTService.
 */
export interface BaseWhisperSTTServiceOptions extends SegmentedSTTServiceOptions {
  /** Service API key. Defaults to null. */
  apiKey?: string | null;
  /** Service API base URL. Defaults to null. */
  baseUrl?: string | null;
  /**
   * Custom `fetch` for API requests, e.g. one with a longer request timeout.
   * Defaults to null, which lets the SDK use the global `fetch`.
   */
  httpClient?: typeof fetch | null;
  /**
   * If true, enables probability metrics in API response. Each service
   * implements this differently (see child classes). Defaults to false.
   */
  includeProbMetrics?: boolean;
  /**
   * If true, allow empty `TranscriptionFrame` frames to be pushed downstream
   * instead of discarding them. This is intended for situations where VAD
   * fires even though the user did not speak. In these cases, it is useful to
   * know that nothing was transcribed so that the agent can resume speaking,
   * instead of waiting longer for a transcription. Defaults to false.
   */
  pushEmptyTranscripts?: boolean;
  /** Runtime-updatable settings. When provided, its values take precedence. */
  settings?: BaseWhisperSTTSettings | null;
}

/**
 * Base class for Whisper-based speech-to-text services.
 *
 * Provides common functionality for services implementing the Whisper API interface,
 * including metrics generation and error handling.
 */
export class BaseWhisperSTTService extends SegmentedSTTService {
  static Settings: typeof BaseWhisperSTTSettings = BaseWhisperSTTSettings;
  declare protected _settings: BaseWhisperSTTSettings;

  // Set by services for providers other than OpenAI. Without a key the OpenAI
  // client falls back to OPENAI_API_KEY and would send it to that provider.
  protected static _requiresApiKey = false;

  protected _client: OpenAI;
  protected _includeProbMetrics: boolean;
  protected _pushEmptyTranscripts: boolean;

  /**
   * Initialize the Whisper STT service.
   *
   * @param options.apiKey Service API key. Defaults to null.
   * @param options.baseUrl Service API base URL. Defaults to null.
   * @param options.httpClient Custom `fetch` for API requests, e.g. one with a
   *   longer request timeout. Defaults to null, which lets the SDK build its own
   *   client.
   * @param options.includeProbMetrics If true, enables probability metrics in
   *   API response. Each service implements this differently (see child
   *   classes). Defaults to false.
   * @param options.pushEmptyTranscripts If true, allow empty `TranscriptionFrame`
   *   frames to be pushed downstream instead of discarding them. This is
   *   intended for situations where VAD fires even though the user did not
   *   speak. In these cases, it is useful to know that nothing was transcribed
   *   so that the agent can resume speaking, instead of waiting longer for a
   *   transcription. Defaults to false.
   * @param options.settings Runtime-updatable settings. When provided, its
   *   values take precedence over the defaults.
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to SegmentedSTTService.
   * @throws Error If the service is for a provider other than OpenAI and
   *   `apiKey` is empty (upstream: ValueError).
   */
  constructor(options: BaseWhisperSTTServiceOptions = {}) {
    // Read before super(): a static can be checked here, but `this` cannot.
    const Settings = (new.target as typeof BaseWhisperSTTService).Settings;
    if ((new.target as typeof BaseWhisperSTTService)._requiresApiKey && !options.apiKey) {
      throw new Error(`${new.target.name} requires an api_key.`);
    }

    // --- 1. Hardcoded defaults ---
    const defaultSettings = new Settings({
      model: null,
      language: null,
      prompt: null,
      temperature: null,
    });

    // --- 2. (deprecated direct-arg overrides are not ported) ---

    // --- 3. (no params object for this service) ---

    // --- 4. Settings delta (canonical API, always wins) ---
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      ttfsP99Latency:
        options.ttfsP99Latency === undefined ? WHISPER_TTFS_P99 : options.ttfsP99Latency,
      settings: defaultSettings,
    });

    this._client = new OpenAI({
      apiKey: options.apiKey ?? undefined,
      baseURL: options.baseUrl ?? undefined,
      ...(options.httpClient ? { fetch: options.httpClient } : {}),
    });
    this._includeProbMetrics = options.includeProbMetrics ?? false;
    this._pushEmptyTranscripts = options.pushEmptyTranscripts ?? false;
  }

  /**
   * Whether this service can generate processing metrics.
   *
   * @returns True, as this service supports metric generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert from pipecat Language to service language code.
   *
   * @param language The Language value to convert.
   * @returns The corresponding service language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToWhisperLanguage(language);
  }

  /** Handle a transcription result with tracing. */
  protected async _handleTranscription(
    _transcript: string,
    _isFinal: boolean,
    _language: Language | string | null = null,
  ): Promise<void> {}

  static {
    installTracedStt(BaseWhisperSTTService.prototype, "_handleTranscription");
  }

  /**
   * Transcribe audio data to text.
   *
   * @param audio Raw audio data to transcribe.
   * @yields Either a TranscriptionFrame containing the transcribed text or an
   *   ErrorFrame if transcription fails.
   */
  override async *runStt(audio: Uint8Array): AsyncGenerator<Frame, void, unknown> {
    try {
      await this.startProcessingMetrics();

      const response = await this._transcribe(audio);

      await this.stopProcessingMetrics();

      const text = response.text.trim();

      if (!text) {
        logger.warning("Received empty transcription from API");
      }

      if (text || this._pushEmptyTranscripts) {
        await this._handleTranscription(text, true, assertGiven(this._settings.language));
        logger.debug(`Transcription: [${text}]`);
        yield new TranscriptionFrame({
          text,
          userId: this._userId,
          timestamp: timeNowIso8601(),
          result: response,
        });
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    }
  }

  /**
   * Transcribe audio data to text.
   *
   * @param _audio Raw audio data in WAV format.
   * @returns Object containing the transcribed text.
   * @throws Error Must be implemented by subclasses (upstream: NotImplementedError).
   */
  protected async _transcribe(_audio: Uint8Array): Promise<Transcription> {
    throw new Error("NotImplementedError: _transcribe must be implemented by subclasses");
  }
}
