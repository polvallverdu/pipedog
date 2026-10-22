// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/camb/tts.py

/**
 * Camb.ai MARS text-to-speech service implementation.
 *
 * This module provides TTS functionality using Camb.ai's MARS model family,
 * offering high-quality text-to-speech synthesis with streaming support.
 *
 * Features:
 * - MARS models: mars-flash (fast), mars-pro (high quality)
 * - 140+ languages supported
 * - Real-time streaming
 * - Model-specific sample rates: mars-pro (48kHz), mars-flash (22.05kHz)
 *
 * Porting notes:
 * - Upstream uses Camb's Python SDK (`camb-sdk`, `AsyncCambAI`). That SDK is a thin
 *   generated client over one endpoint, so this port calls it directly with `fetch`:
 *   `POST {baseUrl}/tts-stream` with an `x-api-key` header and a JSON body, streaming
 *   the response bytes (camb-sdk 1.5.4, `camb/text_to_speech/raw_client.py`; API reference
 *   https://docs.camb.ai/api-reference/endpoint/create-tts-stream). It runs on Bun, Node,
 *   Deno and Workers, where the Python SDK's `httpx` client has no counterpart.
 * - The SDK's `timeout` (httpx: a limit on each connect and read) is applied the same way:
 *   to the wait for the response and to the wait for each chunk.
 * - Not ported, as deprecated upstream: `InputParams`, and the `params`, `voice_id` and
 *   `model` constructor arguments. Use `settings`.
 */

import {
  abortable,
  currentSignal,
  rethrowIfCancelled,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";
import { ErrorFrame, type Frame, TTSAudioRawFrame } from "@pipedog/core/frames/frames";
import type { FrameProcessorSetup } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Model-specific sample rates
export const MODEL_SAMPLE_RATES: Record<string, number> = {
  "mars-flash": 22050, // 22.05kHz
  "mars-pro": 48000, // 48kHz
  "mars-instruct": 22050, // 22.05kHz
};

/**
 * Convert a Pipecat Language enum to Camb.ai language code.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding Camb.ai language code (BCP-47 format). If
 *   `language` is not in the verified mapping, falls back to the base
 *   language code (e.g., `en` from `en-US`) and logs a warning (via
 *   `resolveLanguage(..., true)`).
 */
export function languageToCambLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.EN]: "en-us",
    [Language.EN_US]: "en-us",
    [Language.EN_GB]: "en-gb",
    [Language.EN_AU]: "en-au",
    [Language.ES]: "es-es",
    [Language.ES_ES]: "es-es",
    [Language.ES_MX]: "es-mx",
    [Language.FR]: "fr-fr",
    [Language.FR_FR]: "fr-fr",
    [Language.FR_CA]: "fr-ca",
    [Language.DE]: "de-de",
    [Language.DE_DE]: "de-de",
    [Language.IT]: "it-it",
    [Language.PT]: "pt-pt",
    [Language.PT_BR]: "pt-br",
    [Language.PT_PT]: "pt-pt",
    [Language.NL]: "nl-nl",
    [Language.PL]: "pl-pl",
    [Language.RU]: "ru-ru",
    [Language.JA]: "ja-jp",
    [Language.KO]: "ko-kr",
    [Language.ZH]: "zh-cn",
    [Language.ZH_CN]: "zh-cn",
    [Language.ZH_TW]: "zh-tw",
    [Language.AR]: "ar-sa",
    [Language.HI]: "hi-in",
    [Language.TR]: "tr-tr",
    [Language.VI]: "vi-vn",
    [Language.TH]: "th-th",
    [Language.ID]: "id-id",
    [Language.MS]: "ms-my",
    [Language.SV]: "sv-se",
    [Language.DA]: "da-dk",
    [Language.NO]: "no-no",
    [Language.FI]: "fi-fi",
    [Language.CS]: "cs-cz",
    [Language.EL]: "el-gr",
    [Language.HE]: "he-il",
    [Language.HU]: "hu-hu",
    [Language.RO]: "ro-ro",
    [Language.SK]: "sk-sk",
    [Language.UK]: "uk-ua",
    [Language.BG]: "bg-bg",
    [Language.HR]: "hr-hr",
    [Language.SR]: "sr-rs",
    [Language.SL]: "sl-si",
    [Language.CA]: "ca-es",
    [Language.EU]: "eu-es",
    [Language.GL]: "gl-es",
    [Language.AF]: "af-za",
    [Language.SW]: "sw-ke",
    [Language.TA]: "ta-in",
    [Language.TE]: "te-in",
    [Language.BN]: "bn-in",
    [Language.MR]: "mr-in",
    [Language.GU]: "gu-in",
    [Language.KN]: "kn-in",
    [Language.ML]: "ml-in",
    [Language.PA]: "pa-in",
    [Language.UR]: "ur-pk",
    [Language.FA]: "fa-ir",
    [Language.TL]: "tl-ph",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

/**
 * Split buffer into aligned audio (2-byte samples) and remainder.
 *
 * @param buffer Raw audio bytes to align.
 * @returns `[aligned audio bytes, remaining bytes]`.
 */
export function _getAlignedAudio(buffer: Uint8Array): [Uint8Array, Uint8Array] {
  const alignedSize = Math.trunc(buffer.length / 2) * 2;
  return [buffer.slice(0, alignedSize), buffer.slice(alignedSize)];
}

export interface CambTTSSettingsOptions extends Omit<TTSSettingsOptions, "voice"> {
  /** Camb.ai voice ID. */
  voice?: number | NotGiven;
  /** Custom instructions for mars-instruct model only. Ignored for other models. Max 1000 characters. */
  userInstructions?: string | null | NotGiven;
}

/**
 * Settings for CambTTSService.
 *
 * - `voice`: Camb.ai voice ID. Overrides `TTSSettings.voice` (a string) because
 *   Camb.ai uses integer voice IDs. The base class types the field as a string, so
 *   reading it from here needs a cast.
 * - `userInstructions`: custom instructions for mars-instruct model only.
 *   Ignored for other models. Max 1000 characters.
 */
export class CambTTSSettings extends TTSSettings {
  userInstructions: string | null | NotGiven = NOT_GIVEN;

  constructor(options: CambTTSSettingsOptions = {}) {
    super({ ...options, voice: undefined });
    this._assignOptions(options);
  }
}

export interface CambTTSServiceOptions extends TTSServiceOptions {
  /** Camb.ai API key for authentication. */
  apiKey: string;
  /**
   * Request timeout in seconds. Defaults to 60.0 (minimum recommended by Camb.ai).
   * Applies to the wait for the response and to the wait for each chunk of audio.
   */
  timeout?: number;
  /**
   * Base URL of the Camb.ai API. Defaults to "https://client.camb.ai/apis".
   *
   * DIVERGENCE: not an upstream option. It stands for the SDK's `base_url` / `environment`.
   */
  baseUrl?: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream calls Camb's Python SDK, which brings its own HTTP client.
   */
  fetch?: typeof fetch | null;
  /** Runtime-updatable settings. */
  settings?: CambTTSSettings | null;
}

/**
 * Camb.ai MARS text-to-speech service.
 *
 * Converts text to speech using Camb.ai's MARS TTS models with support for
 * multiple languages.
 *
 * Models:
 * - mars-flash: Fast inference, 22.05kHz output (default)
 * - mars-pro: High quality, 48kHz output
 *
 * @example
 * // Basic usage with mars-flash (fast)
 * const tts = new CambTTSService({
 *   apiKey: "your-api-key",
 *   settings: new CambTTSService.Settings({ model: "mars-flash" }),
 * });
 *
 * // High quality with mars-pro
 * const proTts = new CambTTSService({
 *   apiKey: "your-api-key",
 *   settings: new CambTTSService.Settings({ voice: 12345, model: "mars-pro" }),
 * });
 */
export class CambTTSService extends TTSService {
  static Settings: typeof CambTTSSettings = CambTTSSettings;
  declare protected _settings: CambTTSSettings;

  static {
    installTracedTts(CambTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _timeout: number;
  protected _baseUrl: string;
  protected _fetch: typeof fetch;

  /**
   * Initialize the Camb.ai TTS service.
   *
   * @param options.apiKey Camb.ai API key for authentication.
   * @param options.timeout Request timeout in seconds. Defaults to 60.0 (minimum
   *   recommended by Camb.ai).
   * @param options.sampleRate Audio sample rate in Hz. If null, uses model-specific default.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: CambTTSServiceOptions) {
    const defaultSettings = new (new.target as typeof CambTTSService).Settings({
      model: "mars-flash",
      voice: 147320,
      language: "en-us",
      userInstructions: null,
    });

    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    // Warn if sample rate doesn't match model's supported rate
    const model = assertGiven(defaultSettings.model);
    const sampleRate = options.sampleRate;
    if (sampleRate && model !== null && sampleRate !== MODEL_SAMPLE_RATES[model]) {
      logger.warning(
        `Camb.ai's ${model} model only supports ${MODEL_SAMPLE_RATES[model] ?? "None"}Hz ` +
          `sample rate. Current rate of ${sampleRate}Hz may cause issues.`,
      );
    }

    super({
      ...options,
      sampleRate: sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._timeout = options.timeout ?? 60.0;
    this._baseUrl = (options.baseUrl ?? "https://client.camb.ai/apis").replace(/\/+$/, "");
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Check if this service can generate processing metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to Camb.ai language format.
   *
   * @param language The language to convert.
   * @returns The Camb.ai-specific language code, or null if not supported.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToCambLanguage(language);
  }

  /**
   * Set up the service.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);

    // Use model-specific sample rate if not explicitly specified
    if (!this._initSampleRate) {
      const model = assertGiven(this._settings.model);
      this._sampleRate = model !== null ? (MODEL_SAMPLE_RATES[model] ?? 22050) : 22050;
    }
  }

  /**
   * Generate speech from text using Camb.ai's TTS API.
   *
   * @param text The text to synthesize into speech (max 3000 characters).
   * @param contextId The context ID for tracking audio frames.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    // Validate text length
    if (text.length > 3000) {
      logger.warning("Text too long for Camb.ai TTS (max 3000 chars), truncating");
      text = text.slice(0, 3000);
    }

    // Aborts the request when this generator ends, however it ends.
    const controller = new AbortController();
    const taskSignal = currentSignal();
    const onTaskAbort = () => controller.abort();
    taskSignal?.addEventListener("abort", onTaskAbort);
    try {
      // Build the request body, as the SDK does
      const body: Dict = {
        text,
        voice_id: this._settings.voice,
        language: this._settings.language,
        speech_model: this._settings.model,
        output_configuration: { format: "pcm_s16le" },
      };

      // Add user instructions if using mars-instruct model
      if (this._settings.model === "mars-instruct" && this._settings.userInstructions) {
        body.user_instructions = this._settings.userInstructions;
      }

      await this.startTtsUsageMetrics(text);

      const response = await waitFor(
        () =>
          abortable(
            this._fetch(`${this._baseUrl}/tts-stream`, {
              method: "POST",
              headers: { "x-api-key": this._apiKey, "content-type": "application/json" },
              body: pyJsonDumps(body),
              signal: controller.signal,
            }),
          ),
        this._timeout,
      );
      if (response.status < 200 || response.status >= 300) {
        const errorBody = await waitFor(() => abortable(response.text()), this._timeout);
        throw new Error(`status_code: ${response.status}, body: ${errorBody}`);
      }

      // Buffer for aligning chunks to 2-byte boundaries (16-bit PCM)
      let audioBuffer: Uint8Array = new Uint8Array(0);

      // Stream audio chunks
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await waitFor(() => abortable(reader.read()), this._timeout);
          if (done) break;
          if (value && value.length > 0) {
            await this.stopTtfbMetrics();
            const joined = new Uint8Array(audioBuffer.length + value.length);
            joined.set(audioBuffer);
            joined.set(value, audioBuffer.length);

            // Only yield complete 16-bit samples (2 bytes per sample)
            const [alignedAudio, rest] = _getAlignedAudio(joined);
            audioBuffer = rest;
            if (alignedAudio.length > 0) {
              yield new TTSAudioRawFrame({
                audio: alignedAudio,
                sampleRate: this.sampleRate,
                numChannels: 1,
                contextId,
              });
            }
          }
        }
      }

      // Yield any remaining complete samples
      if (audioBuffer.length >= 2) {
        const [alignedAudio] = _getAlignedAudio(audioBuffer);
        if (alignedAudio.length > 0) {
          yield new TTSAudioRawFrame({
            audio: alignedAudio,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId,
          });
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({
        error: `Camb.ai TTS error: ${e instanceof TimeoutError ? "timed out" : errorMessage(e)}`,
      });
    } finally {
      taskSignal?.removeEventListener("abort", onTaskAbort);
      controller.abort();
    }
  }
}
