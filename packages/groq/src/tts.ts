// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/groq/tts.py

/**
 * Groq text-to-speech service implementation.
 *
 * Porting notes:
 * - Upstream uses the `groq` Python SDK (`AsyncGroq.audio.speech.create`).
 *   Here the request goes straight to Groq's OpenAI-compatible HTTP endpoint,
 *   `POST {baseUrl}/audio/speech`, with `fetch`, so it runs on every runtime.
 * - Deprecated APIs are not ported: `GroqTTSService.InputParams` and the
 *   `params`, `model_name` and `voice_id` constructor options.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { readWav } from "@pipedog/core/audio/utils";
import { ErrorFrame, type Frame, TTSAudioRawFrame } from "@pipedog/core/frames/frames";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

/** Output formats Groq's speech API accepts. */
export type GroqAudioFormat = "flac" | "mp3" | "mulaw" | "ogg" | "wav";

export interface GroqTTSSettingsOptions extends TTSSettingsOptions {
  /** Speech speed multiplier. Defaults to 1.0. */
  speed?: number | null | NotGiven;
}

/**
 * Settings for GroqTTSService.
 *
 * - `speed`: Speech speed multiplier. Defaults to 1.0.
 */
export class GroqTTSSettings extends TTSSettings {
  speed: number | null | NotGiven = NOT_GIVEN;

  constructor(options: GroqTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface GroqTTSServiceOptions extends TTSServiceOptions {
  /** Groq API key for authentication. */
  apiKey: string;
  /** Audio output format. Defaults to "wav". */
  outputFormat?: GroqAudioFormat | (string & {});
  /**
   * Base URL of Groq's OpenAI-compatible API. Defaults to
   * `"https://api.groq.com/openai/v1"`. (Upstream: the SDK's default.)
   */
  baseUrl?: string | null;
  /** Runtime-updatable settings; values override the built-in defaults. */
  settings?: GroqTTSSettings | null;
}

/**
 * Groq text-to-speech service implementation.
 *
 * Provides text-to-speech synthesis using Groq's TTS API. The service
 * operates at a default 24kHz sample rate and supports various voices, output
 * formats, and sample rates.
 */
export class GroqTTSService extends TTSService {
  static Settings: typeof GroqTTSSettings = GroqTTSSettings;
  declare protected _settings: GroqTTSSettings;

  static {
    installTracedTts(GroqTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _outputFormat: string;
  protected _baseUrl: string;

  /**
   * Initialize Groq TTS service.
   *
   * @param options.apiKey Groq API key for authentication.
   * @param options.outputFormat Audio output format. Defaults to "wav".
   * @param options.baseUrl Base URL of Groq's API. Defaults to
   *   "https://api.groq.com/openai/v1".
   * @param options.sampleRate Audio sample rate. If null, uses default sample rate.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "canopylabs/orpheus-v1-english", voice
   *   "autumn", language "en", speed 1.0).
   *   Other options are passed to the parent TTSService class.
   */
  constructor(options: GroqTTSServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof GroqTTSService).Settings({
      model: "canopylabs/orpheus-v1-english",
      voice: "autumn",
      language: "en",
      speed: 1.0,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pauseFrameProcessing: true,
      pushStartFrame: true,
      pushStopFrames: true,
      sampleRate: options.sampleRate ?? null,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey;
    this._outputFormat = options.outputFormat ?? "wav";
    this._baseUrl = (options.baseUrl ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Groq TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Generate speech from text using Groq's TTS API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech data.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame, void> {
    let measuringTtfb = true;
    try {
      const model = assertGiven(this._settings.model);
      const voice = assertGiven(this._settings.voice);
      const speed = assertGiven(this._settings.speed);
      if (model === null) {
        throw new Error("Groq TTS model must be specified");
      }
      if (voice === null) {
        throw new Error("Groq TTS voice must be specified");
      }
      if (speed === null) {
        throw new Error("Groq TTS speed must be specified");
      }
      const response = await abortable(
        fetch(`${this._baseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this._apiKey}`,
            "Content-Type": "application/json",
          },
          body: pyJsonDumps({
            model,
            voice,
            // Any string is passed through (e.g. a newer format not yet in
            // GroqAudioFormat). If the value is unsupported, Groq's API
            // surfaces a runtime error with a clear message.
            response_format: this._outputFormat,
            // Note: as of 2026-02-25, only a speed of 1.0 is supported, but
            // here we pass it for completeness and future-proofing
            speed,
            input: text,
          }),
          signal: currentSignal(),
        }),
      );
      if (!response.ok) {
        const error = await abortable(response.text());
        throw new Error(`Error code: ${response.status} - ${error}`);
      }

      // DIVERGENCE: upstream parses each chunk of `response.iter_bytes()` as a
      // whole WAV file. Here the full body is read and parsed once, which
      // gives the same frame for a response that fits in one chunk and a
      // correct one for a response that doesn't.
      const data = new Uint8Array(await abortable(response.arrayBuffer()));
      if (measuringTtfb) {
        await this.stopTtfbMetrics();
        measuringTtfb = false;
      }
      const wav = readWav(data);
      yield new TTSAudioRawFrame({
        audio: wav.audio,
        sampleRate: wav.sampleRate,
        numChannels: wav.numChannels,
        contextId,
      });
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({
        error: `Unknown error occurred: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}
