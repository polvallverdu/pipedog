// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/hume/tts.py

/**
 * Hume Text-to-Speech service implementation.
 *
 * Porting notes:
 * - Upstream calls the Hume Python SDK's `tts.synthesize_json_streaming`. This
 *   port calls the same endpoint directly with `fetch`, so it runs on Bun,
 *   Node, Deno and Workers without the SDK: `POST https://api.hume.ai/v0/tts/stream/json`
 *   with the `X-Hume-Api-Key` header, a JSON body (`utterances`, `format`,
 *   `instant_mode`, `version`, `include_timestamp_types`, `temperature`) and a
 *   response of newline-delimited JSON objects (`type: "audio"` with base64
 *   `audio`, and `type: "timestamp"`). The wire format was read from the
 *   `hume` TypeScript SDK (0.16.1: `api/resources/tts/client/Client`,
 *   `serialization/resources/tts/types/*`) and the API reference,
 *   https://dev.hume.ai/reference/text-to-speech-tts/synthesize-json-streaming.
 * - DIVERGENCE: upstream owns an `httpx.AsyncClient` that it closes on stop,
 *   cancel and cleanup. `fetch` has nothing to close, so those overrides are
 *   dropped; the optional `fetch` option replaces the SDK's client.
 * - DIVERGENCE: the tracking headers name the client `pipedog` (with the
 *   pipedog version) rather than `pipecat`.
 * - Deprecated APIs are not ported: `InputParams`, `update_setting`, and the
 *   `voice_id` and `params` constructor parameters.
 * - Settings fields are camelCase (`trailing_silence` is `trailingSilence`).
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  type StartFrame,
  TTSAudioRawFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { getEnv } from "@pipedog/core/utils/env";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import { VERSION } from "@pipedog/core/version";

type Dict = Record<string, any>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Hume TTS streams at 48 kHz. */
export const HUME_SAMPLE_RATE = 48_000;

/** Tracking headers for Hume API requests. */
export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  "X-Hume-Client-Name": "pipedog",
  "X-Hume-Client-Version": VERSION,
};

const HUME_BASE_URL = "https://api.hume.ai";

export interface HumeTTSSettingsOptions extends TTSSettingsOptions {
  /** Natural-language acting directions (up to 100 characters). */
  description?: string | null | NotGiven;
  /** Speaking-rate multiplier (0.5-2.0). */
  speed?: number | null | NotGiven;
  /** Seconds of silence to append at the end (0-5). Wire name `trailing_silence`. */
  trailingSilence?: number | null | NotGiven;
  /**
   * Sampling temperature for speech generation. Higher values increase
   * variation, lower values increase consistency. When unset, Hume applies its
   * own per-model default.
   */
  temperature?: number | null | NotGiven;
}

/**
 * Settings for HumeTTSService.
 *
 * - `description`: natural-language acting directions (up to 100 characters).
 * - `speed`: speaking-rate multiplier (0.5-2.0).
 * - `trailingSilence`: seconds of silence to append at the end (0-5).
 * - `temperature`: sampling temperature for speech generation. Higher values
 *   increase variation, lower values increase consistency. When unset, Hume
 *   applies its own per-model default.
 */
export class HumeTTSSettings extends TTSSettings {
  description: string | null | NotGiven = NOT_GIVEN;
  speed: number | null | NotGiven = NOT_GIVEN;
  trailingSilence: number | null | NotGiven = NOT_GIVEN;
  temperature: number | null | NotGiven = NOT_GIVEN;

  constructor(options: HumeTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface HumeTTSServiceOptions extends TTSServiceOptions {
  /** Hume API key. If omitted, reads the `HUME_API_KEY` environment variable. */
  apiKey?: string | null;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: replaces the Hume SDK's HTTP client.
   */
  fetch?: typeof fetch | null;
  /** Base URL of the Hume API. Defaults to "https://api.hume.ai". */
  baseUrl?: string;
  /** Runtime-updatable settings. */
  settings?: HumeTTSSettings | null;
}

/**
 * Yield a stream's lines as they arrive (the Hume SDK splits the stream on
 * `"\n"`).
 */
async function* iterLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) yield line;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}

/**
 * Hume Octave Text-to-Speech service.
 *
 * Streams PCM audio via Hume's HTTP output streaming (JSON chunks) endpoint
 * and emits `TTSAudioRawFrame` frames suitable for Pipecat transports.
 *
 * Supported features:
 *
 * - Generates speech from text using Hume TTS.
 * - Streams PCM audio.
 * - Supports word-level timestamps for precise audio-text synchronization.
 * - Supports dynamic updates of voice and synthesis parameters at runtime.
 * - Provides metrics for Time To First Byte (TTFB) and TTS usage.
 */
export class HumeTTSService extends TTSService {
  static Settings: typeof HumeTTSSettings = HumeTTSSettings;
  declare protected _settings: HumeTTSSettings;

  static {
    installTracedTts(HumeTTSService.prototype, "runTts");
  }

  protected _apiKey: string;
  protected _fetch: typeof fetch;
  protected _baseUrl: string;
  protected _audioBytes: Uint8Array;
  protected _cumulativeTime: number;

  /**
   * Initialize the HumeTTSService.
   *
   * @param options.apiKey Hume API key. If omitted, reads the `HUME_API_KEY`
   *   environment variable.
   * @param options.fetch `fetch` used for HTTP requests.
   * @param options.baseUrl Base URL of the Hume API.
   * @param options.sampleRate Output sample rate for emitted PCM frames.
   *   Defaults to 48_000 (Hume).
   * @param options.settings Runtime-updatable settings. Other options are
   *   passed to the parent class.
   */
  constructor(options: HumeTTSServiceOptions = {}) {
    const apiKey = options.apiKey || getEnv("HUME_API_KEY");
    if (!apiKey) {
      throw new Error("HumeTTSService requires an API key (env HUME_API_KEY or apiKey)");
    }

    const sampleRate = options.sampleRate === undefined ? HUME_SAMPLE_RATE : options.sampleRate;
    if (sampleRate !== HUME_SAMPLE_RATE) {
      logger.warning(
        `Hume TTS streams at ${HUME_SAMPLE_RATE} Hz; configured sampleRate=${sampleRate}`,
      );
    }

    // 1. Initialize defaultSettings with hardcoded defaults
    const defaultSettings = new (new.target as typeof HumeTTSService).Settings({
      model: null,
      voice: null,
      language: null, // Not applicable here
      description: null,
      speed: null,
      trailingSilence: null,
      temperature: null,
    });

    // 2. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate,
      pushTextFrames: false,
      pushStopFrames: true,
      pushStartFrame: true,
      settings: defaultSettings,
    });

    this._apiKey = apiKey;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this._baseUrl = (options.baseUrl ?? HUME_BASE_URL).replace(/\/+$/, "");

    this._audioBytes = new Uint8Array(0);

    // Track cumulative time for word timestamps across utterances
    this._cumulativeTime = 0.0;
  }

  /**
   * Can generate metrics.
   *
   * @returns True if metrics can be generated, false otherwise.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Start the service.
   *
   * @param frame The start frame.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    this._resetState();
  }

  /** Reset internal state variables. */
  protected _resetState(): void {
    this._cumulativeTime = 0.0;
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
      // Reset timing on interruption or stop
      this._resetState();
    }
  }

  /** Build the request body of Hume's `POST /v0/tts/stream/json`. */
  protected _buildRequest(text: string, voiceId: string): Dict {
    const s = this._settings;

    // Build the request payload
    const utterance: Dict = {
      text,
      voice: { id: voiceId },
    };
    if (s.description !== null) {
      utterance.description = s.description;
    }
    if (s.speed !== null) {
      utterance.speed = s.speed;
    }
    if (s.trailingSilence !== null) {
      utterance.trailing_silence = s.trailingSilence;
    }

    // Use version "2" by default if no description is provided
    // Version "1" is needed when description is used
    const version = s.description !== null ? "1" : "2";

    const request: Dict = {
      utterances: [utterance],
      // Request raw PCM chunks in the streaming JSON
      format: { type: "pcm" },
      // Instant mode is always enabled here (not user-configurable)
      instant_mode: true,
      version,
      // Request word-level timestamps
      include_timestamp_types: ["word"],
    };
    if (s.temperature !== null) {
      request.temperature = s.temperature;
    }
    return request;
  }

  /**
   * Generate speech from text using Hume TTS with word timestamps.
   *
   * @param text The text to be synthesized.
   * @param contextId Unique identifier for this TTS context.
   * @yields Frames, including `TTSAudioRawFrame` and `ErrorFrame`.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    logger.debug(`${this}: Generating Hume TTS: [${text}]`);

    const voiceId = assertGiven(this._settings.voice);
    if (voiceId === null) {
      yield new ErrorFrame({ error: "Hume TTS voice must be specified" });
      return;
    }
    const request = this._buildRequest(text, voiceId);

    await this.startTtsUsageMetrics(text);

    try {
      // Hume emits mono PCM at 48 kHz; downstream can resample if needed.
      // We buffer audio bytes before sending to prevent glitches.
      this._audioBytes = new Uint8Array(0);

      // Track the duration of this utterance based on the last timestamp
      let utteranceDuration = 0.0;

      const response = await abortable(
        this._fetch(`${this._baseUrl}/v0/tts/stream/json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hume-Api-Key": this._apiKey,
            ...DEFAULT_HEADERS,
          },
          body: pyJsonDumps(request),
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        const errorText = await abortable(response.text());
        throw new Error(`Hume TTS HTTP ${response.status}: ${errorText}`);
      }
      if (!response.body) {
        throw new Error("Hume TTS returned no response body");
      }

      for await (const line of iterLines(response.body)) {
        const chunk = JSON.parse(line) as Dict;

        // Process audio chunks
        const audioB64: string | undefined = chunk.audio;
        if (audioB64) {
          await this.stopTtfbMetrics();
          const pcmBytes = base64ToBytes(audioB64);
          const merged = new Uint8Array(this._audioBytes.length + pcmBytes.length);
          merged.set(this._audioBytes, 0);
          merged.set(pcmBytes, this._audioBytes.length);
          this._audioBytes = merged;

          // Buffer audio until we have enough to avoid glitches
          if (this._audioBytes.length >= this.chunkSize) {
            const frame = new TTSAudioRawFrame({
              audio: this._audioBytes,
              sampleRate: this.sampleRate,
              numChannels: 1,
              contextId,
            });
            yield frame;
            this._audioBytes = new Uint8Array(0);
          }
        }

        // Process timestamp messages
        if (chunk.type === "timestamp") {
          const timestamp = chunk.timestamp;
          if (timestamp.type === "word") {
            // Convert milliseconds to seconds and add cumulative offset
            const wordStartTime = this._cumulativeTime + timestamp.time.begin / 1000.0;
            const wordEndTime = this._cumulativeTime + timestamp.time.end / 1000.0;

            // Track the maximum end time for this utterance
            utteranceDuration = Math.max(utteranceDuration, wordEndTime);

            // Add word timestamp
            await this.addWordTimestamps([[timestamp.text, wordStartTime]], contextId);
          }
        }
      }

      // Flush any remaining audio bytes
      if (this._audioBytes.length > 0) {
        const frame = new TTSAudioRawFrame({
          audio: this._audioBytes,
          sampleRate: this.sampleRate,
          numChannels: 1,
          contextId,
        });

        yield frame;

        this._audioBytes = new Uint8Array(0);
      }

      // Update cumulative time for next utterance
      if (utteranceDuration > 0) {
        this._cumulativeTime = utteranceDuration;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Unknown error occurred: ${errorMessage(e)}`, { exception: e });
    } finally {
      // Ensure TTFB timer is stopped even on early failures
      await this.stopTtfbMetrics();
    }
  }
}
