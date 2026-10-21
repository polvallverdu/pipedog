// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/groq/stt.py

/**
 * Groq speech-to-text service implementation using Whisper models.
 *
 * Porting notes:
 * - The deprecated `model`, `language`, `prompt` and `temperature` constructor
 *   options are not ported (use `settings`).
 * - The upload is a `File` (`("audio.wav", audio, "audio/wav")` upstream),
 *   which the OpenAI SDK sends as multipart form data.
 */

import { GROQ_TTFS_P99 } from "@pipedog/core/services/stt_latency";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  BaseWhisperSTTService,
  type BaseWhisperSTTServiceOptions,
  BaseWhisperSTTSettings,
  type Transcription,
} from "@pipedog/whisper/base_stt";

/**
 * Settings for the Groq STT service.
 *
 * - `prompt`: Optional prompt text to guide transcription style.
 */
export class GroqSTTSettings extends BaseWhisperSTTSettings {}

export interface GroqSTTServiceOptions extends BaseWhisperSTTServiceOptions {
  /** Groq API key. */
  apiKey: string;
  /** API base URL. Defaults to `"https://api.groq.com/openai/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings. */
  settings?: GroqSTTSettings | null;
}

/**
 * Groq Whisper speech-to-text service.
 *
 * Uses Groq's Whisper API to convert audio to text.
 */
export class GroqSTTService extends BaseWhisperSTTService {
  static override Settings: typeof GroqSTTSettings = GroqSTTSettings;
  declare protected _settings: GroqSTTSettings;
  protected static override _requiresApiKey = true;

  /**
   * Initialize Groq STT service.
   *
   * @param options.apiKey Groq API key.
   * @param options.baseUrl API base URL. Defaults to
   *   "https://api.groq.com/openai/v1".
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "whisper-large-v3-turbo", language English).
   * @param options.ttfsP99Latency P99 latency from speech end to final
   *   transcript in seconds. Override for your deployment. See
   *   https://github.com/pipecat-ai/stt-benchmark
   *   Other options are passed to BaseWhisperSTTService.
   */
  constructor(options: GroqSTTServiceOptions) {
    // --- 1. Hardcoded defaults ---
    const defaultSettings = new (new.target as typeof GroqSTTService).Settings({
      model: "whisper-large-v3-turbo",
      language: Language.EN,
      prompt: null,
      temperature: null,
    });

    // --- 2. Settings delta (canonical API, always wins) ---
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.groq.com/openai/v1",
      settings: defaultSettings,
      ttfsP99Latency: options.ttfsP99Latency === undefined ? GROQ_TTFS_P99 : options.ttfsP99Latency,
    });
  }

  protected override async _transcribe(audio: Uint8Array): Promise<Transcription> {
    if (this._settings.language === null) {
      throw new Error("AssertionError: language must be set");
    }

    // Build kwargs dict with only set parameters
    const kwargs: Record<string, any> = {
      file: new File([audio as Uint8Array<ArrayBuffer>], "audio.wav", { type: "audio/wav" }),
      model: this._settings.model,
      // Use verbose_json to get probability metrics
      response_format: this._includeProbMetrics ? "verbose_json" : "json",
      language: this._settings.language,
    };

    if (this._settings.prompt !== null) {
      kwargs.prompt = this._settings.prompt;
    }

    if (this._settings.temperature !== null) {
      kwargs.temperature = this._settings.temperature;
    }

    return (await this._client.audio.transcriptions.create(kwargs as any)) as Transcription;
  }
}
