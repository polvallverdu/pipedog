// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/mistral/tts.py

/**
 * Mistral text-to-speech service implementation.
 *
 * This module provides integration with Mistral's Voxtral TTS API for
 * generating speech from text input using HTTP streaming with Server-Sent
 * Events.
 *
 * Porting notes:
 * - Upstream uses the `mistralai` Python SDK
 *   (`client.audio.speech.complete_async(..., stream=True)`). Here the same
 *   request goes straight to `POST {baseUrl}/audio/speech` with `fetch`, and
 *   the Server-Sent Events are parsed here: `speech.audio.delta` events carry
 *   base64 float32 PCM in `audio_data`, and `speech.audio.done` carries the
 *   usage.
 * - `baseUrl` is new (the SDK's `server_url`); it defaults to Mistral's API.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import { ErrorFrame, type Frame, TTSAudioRawFrame } from "@pipedog/core/frames/frames";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { base64ToBytes } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven } from "@pipedog/core/utils/types";

export interface MistralTTSSettingsOptions extends TTSSettingsOptions {}

/**
 * Settings for MistralTTSService.
 *
 * - `model`: TTS model identifier.
 * - `voice`: Voice identifier.
 * - `language`: Language for speech synthesis.
 */
export class MistralTTSSettings extends TTSSettings {
  constructor(options: MistralTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface MistralTTSServiceOptions extends TTSServiceOptions {
  /** Mistral API key for authentication. */
  apiKey?: string | null;
  /** Base URL of Mistral's API. Defaults to `"https://api.mistral.ai/v1"`. */
  baseUrl?: string | null;
  /** Runtime-updatable settings. */
  settings?: MistralTTSSettings | null;
}

/** One Server-Sent Event: its `event` name and joined `data` lines. */
interface ServerSentEvent {
  event: string | null;
  data: string;
}

/** Parse a Server-Sent Events body into events. */
async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<ServerSentEvent, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  const takeLine = function* (line: string): Generator<ServerSentEvent> {
    if (line === "") {
      if (data.length > 0) yield { event, data: data.join("\n") };
      event = null;
      data = [];
    } else if (line.startsWith(":")) {
      // Comment.
    } else {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  };
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r\n|\r|\n/);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        const sepLength = buffer.startsWith("\r\n", newline) ? 2 : 1;
        buffer = buffer.slice(newline + sepLength);
        yield* takeLine(line);
        newline = buffer.search(/\r\n|\r|\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer) yield* takeLine(buffer);
    yield* takeLine("");
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}

/**
 * Mistral Text-to-Speech service using the Voxtral TTS API.
 *
 * This service uses Mistral's streaming TTS API to generate PCM-encoded audio
 * at 24kHz. The API returns base64-encoded float32 PCM chunks via
 * Server-Sent Events, which are converted to int16 for the Pipecat pipeline.
 */
export class MistralTTSService extends TTSService {
  static Settings: typeof MistralTTSSettings = MistralTTSSettings;
  declare protected _settings: MistralTTSSettings;

  static MISTRAL_SAMPLE_RATE = 24000;

  static {
    installTracedTts(MistralTTSService.prototype, "runTts");
  }

  protected _apiKey: string | null;
  protected _baseUrl: string;

  /**
   * Initialize Mistral TTS service.
   *
   * @param options.apiKey Mistral API key for authentication.
   * @param options.baseUrl Base URL of Mistral's API. Defaults to
   *   "https://api.mistral.ai/v1".
   * @param options.sampleRate Output audio sample rate in Hz. Audio is
   *   resampled from Mistral's native 24kHz when a different rate is requested.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to TTSService.
   */
  constructor(options: MistralTTSServiceOptions = {}) {
    // Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof MistralTTSService).Settings({
      model: "voxtral-mini-tts-2603",
      voice: null,
      language: null,
    });

    // Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      sampleRate: options.sampleRate ?? null,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    this._apiKey = options.apiKey ?? null;
    this._baseUrl = (options.baseUrl ?? "https://api.mistral.ai/v1").replace(/\/+$/, "");
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Mistral TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert float32 PCM audio data to int16 PCM.
   *
   * @param data Raw bytes containing float32 LE PCM samples.
   * @returns Raw bytes containing int16 LE PCM samples.
   */
  static _float32ToInt16(data: Uint8Array): Uint8Array {
    const n = Math.floor(data.length / 4);
    const view = new DataView(data.buffer, data.byteOffset, n * 4);
    const out = new Uint8Array(n * 2);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < n; i++) {
      const f = view.getFloat32(i * 4, true);
      const s = Math.min(32767, Math.max(-32768, Math.trunc(f * 32767)));
      outView.setInt16(i * 2, s, true);
    }
    return out;
  }

  /**
   * Generate speech from text using Mistral's TTS API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech data.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame, void> {
    try {
      await this.startTtsUsageMetrics(text);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (this._apiKey) headers.Authorization = `Bearer ${this._apiKey}`;
      const response = await abortable(
        fetch(`${this._baseUrl}/audio/speech`, {
          method: "POST",
          headers,
          body: pyJsonDumps({
            input: text,
            model: assertGiven(this._settings.model),
            voice_id: assertGiven(this._settings.voice),
            response_format: "pcm",
            stream: true,
          }),
          signal: currentSignal(),
        }),
      );
      if (!response.ok) {
        const error = await abortable(response.text());
        throw new Error(`API error occurred: Status ${response.status}. Body: ${error}`);
      }

      for await (const sse of parseServerSentEvents(response.body)) {
        if (sse.data === "[DONE]") break;
        const event = pyJsonLoads(sse.data) as Record<string, any>;
        const type = event.type ?? sse.event;
        if (type === "speech.audio.delta") {
          const audioBytes = base64ToBytes(event.audio_data as string);
          const audioInt16 = MistralTTSService._float32ToInt16(audioBytes);
          const audioData = await this._resampler.resample(
            audioInt16,
            MistralTTSService.MISTRAL_SAMPLE_RATE,
            this.sampleRate,
          );
          await this.stopTtfbMetrics();
          yield new TTSAudioRawFrame({
            audio: audioData,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId,
          });
        } else if (type === "speech.audio.done") {
          logger.debug(`${this}: Usage info: ${pyJsonDumps(event.usage ?? null)}`);
        }
      }
    } catch (e) {
      rethrowIfCancelled(e);
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`${this} error generating TTS: ${message}`);
      yield new ErrorFrame({ error: `Error generating TTS: ${message}` });
    }
  }
}
