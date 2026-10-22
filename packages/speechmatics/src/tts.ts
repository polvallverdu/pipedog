// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/speechmatics/tts.py

/**
 * Speechmatics TTS service integration.
 *
 * Uses the Speechmatics HTTP TTS API: `POST {base_url}/generate/{voice}` with a
 * `{"text": ...}` JSON body, an `Authorization: Bearer` header and an
 * `output_format` query parameter (`pcm_16000` for raw 16 kHz, 16-bit signed
 * mono little-endian PCM). The audio is streamed in the response body. See
 * https://docs.speechmatics.com/text-to-speech/quickstart .
 *
 * Porting notes:
 * - The shared `aiohttp.ClientSession` becomes a `fetch` option.
 * - Deprecated upstream APIs are not ported: `InputParams`/`params` (use
 *   `settings.maxRetries`) and `voice_id` (use `settings.voice`).
 * - Upstream imports `speechmatics.rt` only to check the package is installed;
 *   no SDK is used here.
 */

import { abortable, currentSignal, rethrowIfCancelled, sleep } from "@pipedog/asyncio";
import { version as pipecatVersion } from "@pipedog/core";
import { ErrorFrame, type Frame, TTSAudioRawFrame } from "@pipedog/core/frames/frames";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { logger } from "@pipedog/core/utils/logger";
import { exponentialBackoffTime } from "@pipedog/core/utils/network";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface SpeechmaticsTTSSettingsOptions extends TTSSettingsOptions {
  /** Maximum number of retries for HTTP requests. */
  maxRetries?: number | NotGiven;
}

/**
 * Settings for SpeechmaticsTTSService.
 *
 * Speechmatics requires a voice (the URL path includes it), so `voice` must be
 * a string.
 */
export class SpeechmaticsTTSSettings extends TTSSettings {
  maxRetries: number | NotGiven = NOT_GIVEN;

  constructor(options: SpeechmaticsTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

/** Signals the retry loop gave up on a 503. */
class RetriesExhausted extends Error {}

export interface SpeechmaticsTTSServiceOptions extends TTSServiceOptions {
  /** Speechmatics API key for authentication. */
  apiKey: string;
  /** Base URL for Speechmatics TTS API. Defaults to "https://preview.tts.speechmatics.com". */
  baseUrl?: string;
  /** `fetch` used for HTTP requests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Audio sample rate in Hz. Speechmatics only supports 16000. */
  sampleRate?: number | null;
  /** Runtime-updatable settings. */
  settings?: SpeechmaticsTTSSettings | null;
}

/**
 * Speechmatics TTS service implementation.
 *
 * This service provides text-to-speech synthesis using the Speechmatics HTTP API.
 * It converts text to speech and returns raw PCM audio data for real-time playback.
 */
export class SpeechmaticsTTSService extends TTSService {
  static Settings: typeof SpeechmaticsTTSSettings = SpeechmaticsTTSSettings;
  declare protected _settings: SpeechmaticsTTSSettings;

  static readonly SPEECHMATICS_SAMPLE_RATE = 16000;

  static {
    installTracedTts(SpeechmaticsTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _baseUrl: string;
  protected _fetch: typeof fetch;

  /**
   * Initialize the Speechmatics TTS service.
   *
   * @param options.apiKey Speechmatics API key for authentication.
   * @param options.baseUrl Base URL for Speechmatics TTS API.
   * @param options.fetch `fetch` used for HTTP requests (upstream: a shared aiohttp session).
   * @param options.sampleRate Audio sample rate in Hz.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to TTSService.
   */
  constructor(options: SpeechmaticsTTSServiceOptions) {
    const sampleRate =
      options.sampleRate === undefined
        ? SpeechmaticsTTSService.SPEECHMATICS_SAMPLE_RATE
        : options.sampleRate;
    if (sampleRate && sampleRate !== SpeechmaticsTTSService.SPEECHMATICS_SAMPLE_RATE) {
      logger.warning(
        `Speechmatics TTS only supports ${SpeechmaticsTTSService.SPEECHMATICS_SAMPLE_RATE}Hz sample rate. ` +
          `Current rate of ${sampleRate}Hz may cause issues.`,
      );
    }

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof SpeechmaticsTTSService).Settings({
      model: null,
      voice: "sarah",
      language: null,
      maxRetries: 5,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    // Service parameters
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl ?? "https://preview.tts.speechmatics.com";
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));

    // Check we have required attributes
    if (!this._apiKey) {
      throw new Error("Missing Speechmatics API key");
    }
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Speechmatics service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Generate speech from text using Speechmatics' HTTP API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    // HTTP headers
    const headers = {
      Authorization: `Bearer ${this._apiKey}`,
      "Content-Type": "application/json",
    };

    // HTTP payload
    const payload = { text };

    // Complete HTTP URL
    const url = _getEndpointUrl(
      this._baseUrl,
      assertGiven(this._settings.voice) as string,
      this.sampleRate,
    );

    try {
      // Track attempt
      let attempt = 0;

      // Keep retrying until we get a 200 response or timeout
      while (true) {
        const response = await abortable(
          this._fetch(url, {
            method: "POST",
            headers,
            body: pyJsonDumps(payload),
            signal: currentSignal(),
          }),
        );

        // 503 : Service unavailable
        if (response.status === 503) {
          // Release the connection.
          await response.body?.cancel().catch(() => {});
          try {
            // Calculate the backoff time
            const backoffTime = exponentialBackoffTime(attempt, 0.25, 8.0, 0.5);

            // Increment attempt
            attempt += 1;

            // Check if we've exceeded the maximum number of attempts
            const maxRetries = assertGiven(this._settings.maxRetries);
            if (maxRetries !== null && maxRetries !== undefined && attempt >= maxRetries) {
              throw new RetriesExhausted();
            }

            // Report error frame
            yield new ErrorFrame({
              error: `Service unavailable [503] (attempt ${attempt}, retry in ${backoffTime.toFixed(2)}s)`,
            });

            // Wait before retrying
            await sleep(backoffTime);

            // Retry
            continue;
          } catch (e) {
            rethrowIfCancelled(e);
            if (e instanceof RetriesExhausted) {
              yield new ErrorFrame({ error: `Service unavailable [503] (attempts ${attempt})` });
              return;
            }
            throw e;
          }
        }

        // != 200 : Error
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          yield new ErrorFrame({ error: `Service unavailable [${response.status}]` });
          return;
        }

        // Update Pipecat metrics
        await this.startTtsUsageMetrics(text);

        // Process the response in streaming chunks
        let firstChunk = true;
        let buffer: Uint8Array = new Uint8Array(0);

        // Iterate over each audio data chunk from the TTS API
        const reader = response.body?.getReader();
        try {
          while (reader) {
            const { done, value } = await abortable(reader.read());
            if (done) break;
            const chunk = value;
            if (!chunk || chunk.length === 0) {
              continue;
            }
            if (firstChunk) {
              await this.stopTtfbMetrics();
              firstChunk = false;
            }

            const merged = new Uint8Array(buffer.length + chunk.length);
            merged.set(buffer, 0);
            merged.set(chunk, buffer.length);
            buffer = merged;

            // Emit all complete 2-byte int16 samples from buffer
            if (buffer.length >= 2) {
              const completeBytes = Math.floor(buffer.length / 2) * 2;

              const audioData = buffer.slice(0, completeBytes);
              buffer = buffer.slice(completeBytes);

              // Emit the audio frame
              yield new TTSAudioRawFrame({
                audio: audioData,
                sampleRate: this.sampleRate,
                numChannels: 1,
                contextId,
              });
            }
          }
        } finally {
          try {
            await reader?.cancel();
          } catch (e) {
            rethrowIfCancelled(e);
          }
        }

        // Successfully processed the response, break out of retry loop
        break;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Error generating TTS: ${errorMessage(e)}` });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}

/**
 * Format the TTS endpoint URL with voice and output format params.
 *
 * @param baseUrl The base URL for the TTS endpoint.
 * @param voice The voice model to use.
 * @param sampleRate The audio sample rate.
 * @returns The formatted TTS endpoint URL.
 */
export function _getEndpointUrl(baseUrl: string, voice: string, sampleRate: number): string {
  const query = new URLSearchParams();
  query.append("output_format", `pcm_${sampleRate}`);
  query.append("sm-app", `pipecat/${pipecatVersion()}`);

  return `${baseUrl}/generate/${voice}?${query.toString()}`;
}
