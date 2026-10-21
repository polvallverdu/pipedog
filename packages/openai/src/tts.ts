// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/openai/tts.py

/**
 * OpenAI text-to-speech service implementation.
 *
 * This module provides integration with OpenAI's text-to-speech API for
 * generating high-quality synthetic speech from text input.
 *
 * Porting notes:
 * - The client is `OpenAI` from the `openai` JS SDK (fetch based). The
 *   streamed body is read from the `Response` the SDK returns, re-chunked to
 *   `chunkSize` bytes as `iter_bytes(chunk_size)` does.
 * - `httpClient` is the SDK's `fetch` option (upstream: an httpx client).
 * - Deprecated APIs are not ported: `OpenAITTSService.InputParams` and the
 *   `voice`, `model`, `instructions`, `speed` and `params` constructor
 *   options.
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  type StartFrame,
  TTSAudioRawFrame,
} from "@pipedog/core/frames/frames";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { logger } from "@pipedog/core/utils/logger";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven } from "@pipedog/core/utils/types";
import OpenAI, { BadRequestError } from "openai";
import { OPENAI_SAMPLE_RATE } from "./_constants.ts";

export type ValidVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "cedar"
  | "coral"
  | "echo"
  | "fable"
  | "marin"
  | "nova"
  | "onyx"
  | "sage"
  | "shimmer"
  | "verse";

export const VALID_VOICES: Readonly<Record<string, ValidVoice>> = {
  alloy: "alloy",
  ash: "ash",
  ballad: "ballad",
  cedar: "cedar",
  coral: "coral",
  echo: "echo",
  fable: "fable",
  marin: "marin",
  nova: "nova",
  onyx: "onyx",
  sage: "sage",
  shimmer: "shimmer",
  verse: "verse",
};

export interface OpenAITTSSettingsOptions extends TTSSettingsOptions {
  /** Instructions to guide voice synthesis behavior. */
  instructions?: string | null | NotGiven;
  /** Voice speed control (0.25 to 4.0, default 1.0). */
  speed?: number | null | NotGiven;
}

/**
 * Settings for OpenAITTSService.
 *
 * - `instructions`: instructions to guide voice synthesis behavior.
 * - `speed`: voice speed control (0.25 to 4.0, default 1.0).
 */
export class OpenAITTSSettings extends TTSSettings {
  instructions: string | null | NotGiven = NOT_GIVEN;
  speed: number | null | NotGiven = NOT_GIVEN;

  constructor(options: OpenAITTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface OpenAITTSServiceOptions extends TTSServiceOptions {
  /** OpenAI API key for authentication. If null, uses environment variable. */
  apiKey?: string | null;
  /** Custom base URL for OpenAI API. If null, uses default. */
  baseUrl?: string | null;
  /**
   * Custom `fetch` for API requests, e.g. one with a longer request timeout.
   * Defaults to null, which lets the SDK use its own.
   *
   * DIVERGENCE: upstream takes an httpx client here.
   */
  httpClient?: typeof fetch | null;
  /** Runtime-updatable settings. */
  settings?: OpenAITTSSettings | null;
}

/** Yield the bytes of a body stream in chunks of exactly `chunkSize` (the last may be shorter). */
async function* iterBytes(
  body: ReadableStream<Uint8Array> | null,
  chunkSize: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (!value || value.length === 0) continue;
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;
      while (buffer.length >= chunkSize) {
        yield buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
      }
    }
    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      rethrowIfCancelled(e);
    }
  }
}

/**
 * OpenAI Text-to-Speech service that generates audio from text.
 *
 * This service uses the OpenAI TTS API to generate PCM-encoded audio at
 * 24kHz. Supports multiple voice models and configurable parameters for
 * high-quality speech synthesis with streaming audio output.
 */
export class OpenAITTSService extends TTSService {
  static Settings: typeof OpenAITTSSettings = OpenAITTSSettings;
  declare protected _settings: OpenAITTSSettings;

  static {
    installTracedTts(OpenAITTSService.prototype, "runTts");
  }

  protected _client: OpenAI;

  /**
   * Initialize OpenAI TTS service.
   *
   * @param options.apiKey OpenAI API key for authentication. If null, uses
   *   environment variable.
   * @param options.baseUrl Custom base URL for OpenAI API. If null, uses default.
   * @param options.httpClient Custom `fetch` for API requests.
   * @param options.sampleRate Output audio sample rate in Hz. If null, uses
   *   OpenAI's default 24kHz.
   * @param options.settings Runtime-updatable settings. Its given fields
   *   override the defaults (model "gpt-4o-mini-tts", voice "alloy").
   *   Other options are passed to TTSService.
   */
  constructor(options: OpenAITTSServiceOptions = {}) {
    const sampleRate = options.sampleRate ?? null;
    if (sampleRate && sampleRate !== OPENAI_SAMPLE_RATE) {
      logger.warning(
        `OpenAI TTS only supports ${OPENAI_SAMPLE_RATE}Hz sample rate. ` +
          `Current rate of ${sampleRate}Hz may cause issues.`,
      );
    }

    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof OpenAITTSService).Settings({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      language: null,
      instructions: null,
      speed: null,
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

    this._client = new OpenAI({
      apiKey: options.apiKey ?? undefined,
      baseURL: options.baseUrl ?? undefined,
      ...(options.httpClient ? { fetch: options.httpClient } : {}),
    });
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as OpenAI TTS service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Start the OpenAI TTS service.
   *
   * @param frame The start frame containing initialization parameters.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    if (this.sampleRate !== OPENAI_SAMPLE_RATE) {
      logger.warning(
        `OpenAI TTS requires ${OPENAI_SAMPLE_RATE}Hz sample rate. ` +
          `Current rate of ${this.sampleRate}Hz may cause issues.`,
      );
    }
  }

  /**
   * Generate speech from text using OpenAI's TTS API.
   *
   * @param text The text to synthesize into speech.
   * @param contextId The context ID for tracking audio frames.
   * @returns Audio frames containing the synthesized speech data.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame, void> {
    const voice = assertGiven(this._settings.voice);
    if (voice === null) {
      yield new ErrorFrame({ error: "OpenAI TTS voice must be specified" });
      return;
    }
    if (!Object.hasOwn(VALID_VOICES, voice)) {
      yield new ErrorFrame({
        error:
          `OpenAI TTS voice '${voice}' is not supported ` +
          `(must be one of: ${Object.keys(VALID_VOICES).sort().join(", ")})`,
      });
      return;
    }
    try {
      // Setup API parameters
      const createParams: Record<string, unknown> = {
        input: text,
        model: this._settings.model,
        voice: VALID_VOICES[voice],
        response_format: "pcm",
      };

      if (this._settings.instructions) {
        createParams.instructions = this._settings.instructions;
      }

      if (this._settings.speed) {
        createParams.speed = this._settings.speed;
      }

      const r = await abortable(
        this._client.audio.speech.create(
          createParams as unknown as OpenAI.Audio.SpeechCreateParams,
          { signal: currentSignal() },
        ),
      );
      if (r.status !== 200) {
        const error = await abortable(r.text());
        logger.error(`${this} error getting audio (status: ${r.status}, error: ${error})`);
        yield new ErrorFrame({
          error: `Error getting audio (status: ${r.status}, error: ${error})`,
        });
        return;
      }

      await this.startTtsUsageMetrics(text);

      const CHUNK_SIZE = this.chunkSize;

      for await (const chunk of iterBytes(r.body, CHUNK_SIZE)) {
        if (chunk.length > 0) {
          await this.stopTtfbMetrics();
          const frame = new TTSAudioRawFrame({
            audio: chunk,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId,
          });
          yield frame;
        }
      }
    } catch (e) {
      if (e instanceof BadRequestError) {
        yield new ErrorFrame({ error: `Unknown error occurred: ${e.message}` });
        return;
      }
      throw e;
    }
  }
}
