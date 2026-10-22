// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/piper/tts.py

/**
 * Piper TTS service implementation.
 *
 * Porting notes:
 * - The `piper` package is reimplemented in `piper_voice.ts` (same voice
 *   files, phonemization, phoneme ids and inference) on `@pipedog/onnx` and
 *   `@pipedog/espeak-ng`. It is imported lazily, so `PiperHttpTTSService`
 *   never loads it and runs anywhere `fetch` does (Cloudflare Workers too).
 * - The deprecated `voice_id` argument is not ported; use `settings`.
 * - DIVERGENCE: upstream downloads and loads the voice in the constructor.
 *   Loading is asynchronous here, so the constructor only checks that a voice
 *   is set; the voice is downloaded and loaded in `start()` (or on first
 *   use), once.
 * - DIVERGENCE: the default download directory is `modelCacheDir("piper")`
 *   (`~/.cache/pipedog/piper`, see `@pipedog/onnx`), not `~/.cache/pipecat/piper`.
 * - DIVERGENCE: `useCuda` is accepted but has no effect (CPU only).
 * - `PiperHttpTTSService`: upstream's required `aiohttp_session` becomes an
 *   optional `fetch` function (defaults to the global `fetch`).
 */

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  type StartFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { logger } from "@pipedog/core/utils/logger";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { requireGiven } from "@pipedog/core/utils/types";
import type { OnnxBackend } from "@pipedog/onnx";
import type { AudioChunk, PiperVoice } from "./piper_voice.ts";

/** Name of the cache directory under the pipedog cache (`modelCacheDir`). */
export const PIPER_CACHE_DIR_NAME = "piper";

/**
 * The default download directory for Piper voices.
 *
 * DIVERGENCE: upstream's `PIPER_CACHE_DIR` is `~/.cache/pipecat/piper`.
 */
export async function piperCacheDir(): Promise<string> {
  // Imported lazily: @pipedog/onnx's cache helpers need a filesystem.
  const { modelCacheDir } = await import("@pipedog/onnx");
  return modelCacheDir(PIPER_CACHE_DIR_NAME);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function joinPath(dir: string, file: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${file}` : `${dir}/${file}`;
}

/** Settings for PiperTTSService. */
export class PiperTTSSettings extends TTSSettings {
  constructor(options: TTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface PiperTTSServiceOptions extends TTSServiceOptions {
  /**
   * Directory for storing voice model files. Defaults to pipedog's cache
   * directory (`piperCacheDir()`).
   */
  downloadDir?: string | null;
  /** Re-download the voice model even if it already exists. */
  forceRedownload?: boolean;
  /**
   * Use CUDA for GPU-accelerated inference.
   *
   * DIVERGENCE: accepted but has no effect; inference runs on the ONNX
   * backend's default (CPU) execution provider.
   */
  useCuda?: boolean;
  /** `fetch` for downloads (default: the global `fetch`). Not upstream. */
  fetch?: typeof fetch | null;
  /** The ONNX backend (default: `createOnnxBackend()`). Not upstream. */
  backend?: OnnxBackend | Promise<OnnxBackend> | null;
  /** Runtime-updatable settings. */
  settings?: PiperTTSSettings | null;
}

/** Yield each chunk's int16 bytes, abortable at every chunk (`async_iterator`). */
async function* audioBytes(chunks: AsyncGenerator<AudioChunk>): AsyncGenerator<Uint8Array> {
  try {
    while (true) {
      const item = await abortable(chunks.next());
      if (item.done) return;
      yield item.value.audioInt16Bytes;
    }
  } finally {
    // Stop synthesizing further sentences if we leave early.
    chunks.return(undefined).catch(() => {});
  }
}

/**
 * Piper TTS service implementation.
 *
 * Provides local text-to-speech synthesis using Piper voice models.
 * Automatically downloads voice models if not already present and resamples
 * audio output to match the configured sample rate.
 *
 * Note: upstream runs Piper in-process via the `piper-tts` package, which is
 * GPL-3.0 licensed. This port runs its own BSD-licensed engine, but it
 * phonemizes with eSpeak NG (`@echogarden/espeak-ng-emscripten`), which is
 * GPL-3.0, as is the case upstream. To keep eSpeak NG out of your
 * application, use `PiperHttpTTSService`, which talks to a separately
 * installed Piper HTTP server.
 */
export class PiperTTSService extends TTSService {
  static Settings: typeof PiperTTSSettings = PiperTTSSettings;
  declare protected _settings: PiperTTSSettings;

  static {
    installTracedTts(PiperTTSService.prototype, "runTts");
  }

  protected _voice: PiperVoice | null = null;
  protected _voiceLoading: Promise<PiperVoice> | null = null;
  readonly #options: PiperTTSServiceOptions;

  /**
   * Initialize the Piper TTS service.
   *
   * @param options.downloadDir Directory for storing voice model files.
   *   Defaults to pipedog's cache directory.
   * @param options.forceRedownload Re-download the voice model even if it
   *   already exists.
   * @param options.useCuda Use CUDA for GPU-accelerated inference (no effect).
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent `TTSService`.
   */
  constructor(options: PiperTTSServiceOptions = {}) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof PiperTTSService).Settings({
      model: null,
      voice: null,
      language: null,
    });

    // 2. The deprecated voice_id argument is not ported.
    // 3. (No step 3, as there's no params object to apply)

    // 4. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    this.#options = options;

    requireGiven(this._settings.voice, "Piper TTS voice");
  }

  /**
   * Download (if needed) and load the voice, once.
   *
   * DIVERGENCE: upstream does this in the constructor.
   */
  async _loadVoice(): Promise<PiperVoice> {
    if (this._voice) return this._voice;
    if (!this._voiceLoading) {
      const loading = (async () => {
        const { PiperVoice, downloadVoice } = await import("./piper_voice.ts");
        const { fileExists } = await import("@pipedog/onnx");
        const options = this.#options;
        const downloadDir = options.downloadDir ?? (await piperCacheDir());

        const voice = requireGiven(this._settings.voice, "Piper TTS voice");
        const modelPathResolved = joinPath(downloadDir, `${voice}.onnx`);

        if (options.forceRedownload || !(await fileExists(modelPathResolved))) {
          logger.debug(`Downloading Piper '${voice}' model`);
          await downloadVoice(voice, downloadDir, {
            forceRedownload: options.forceRedownload ?? false,
            fetch: options.fetch ?? undefined,
          });
        }

        logger.debug(`Loading Piper '${voice}' model from ${modelPathResolved}`);
        const loaded = await PiperVoice.load(modelPathResolved, {
          useCuda: options.useCuda ?? false,
          backend: options.backend,
        });
        logger.debug(`Loaded Piper '${voice}' model`);
        this._voice = loaded;
        return loaded;
      })();
      this._voiceLoading = loading;
      // A failed load is retried on the next use.
      loading.catch(() => {
        if (this._voiceLoading === loading) this._voiceLoading = null;
      });
    }
    return await this._voiceLoading;
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Piper service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Start the service and load the voice.
   *
   * DIVERGENCE: the voice is loaded here (upstream: in the constructor). A
   * failure is reported as an error and retried on the first synthesis.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    try {
      await abortable(this._loadVoice());
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Failed to load Piper voice: ${errorMessage(e)}`, { exception: e });
    }
  }

  /**
   * Apply a settings delta.
   *
   * Settings are stored but not applied to the active connection.
   */
  protected override async _updateSettings(
    delta: PiperTTSSettings,
  ): Promise<Record<string, unknown>> {
    const changed = await super._updateSettings(delta);
    if (Object.keys(changed).length === 0) {
      return changed;
    }
    // TODO: voice changes would require re-downloading and loading the model.
    this._warnUnhandledUpdatedSettings(changed);
    return changed;
  }

  /**
   * Generate speech from text using Piper.
   *
   * @param text The text to convert to speech.
   * @param contextId Unique identifier for this TTS context.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      await this.startTtsUsageMetrics(text);

      const voice = await abortable(this._loadVoice());
      for await (const frame of this._streamAudioFramesFromIterator(
        audioBytes(voice.synthesize(text)),
        {
          inSampleRate: voice.config.sampleRate,
          contextId,
        },
      )) {
        await this.stopTtfbMetrics();
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      logger.error(`${this} exception: ${errorMessage(e)}`);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    } finally {
      logger.debug(`${this}: Finished TTS [${text}]`);
      await this.stopTtfbMetrics();
    }
  }
}

// This assumes a running TTS service running:
// https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_HTTP.md
//
// Usage:
//
//  $ uv pip install "piper-tts[http]"
//  $ uv run python -m piper.http_server -m en_US-ryan-high
//

/** Settings for PiperHttpTTSService. */
export class PiperHttpTTSSettings extends TTSSettings {
  constructor(options: TTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface PiperHttpTTSServiceOptions extends TTSServiceOptions {
  /** Base URL for the Piper TTS HTTP server. */
  baseUrl: string;
  /**
   * `fetch` used for HTTP requests. Defaults to the global `fetch`.
   *
   * DIVERGENCE: upstream takes a required `aiohttp_session`.
   */
  fetch?: typeof fetch | null;
  /** Runtime-updatable settings. */
  settings?: PiperHttpTTSSettings | null;
}

/**
 * Yield a body stream's bytes as they arrive, in chunks of at most
 * `chunkSize` bytes (aiohttp's `iter_chunked`).
 */
async function* iterChunked(
  body: ReadableStream<Uint8Array> | null,
  chunkSize: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      if (!value || value.length === 0) continue;
      for (let offset = 0; offset < value.length; offset += chunkSize) {
        yield value.subarray(offset, Math.min(offset + chunkSize, value.length));
      }
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
 * Piper HTTP TTS service implementation.
 *
 * Provides integration with Piper's HTTP TTS server for text-to-speech
 * synthesis. Supports streaming audio generation with configurable sample
 * rates and automatic WAV header removal.
 */
export class PiperHttpTTSService extends TTSService {
  static Settings: typeof PiperHttpTTSSettings = PiperHttpTTSSettings;
  declare protected _settings: PiperHttpTTSSettings;

  static {
    installTracedTts(PiperHttpTTSService.prototype, "runTts");
  }

  protected _baseUrl: string;
  protected _fetch: typeof fetch;

  /**
   * Initialize the Piper TTS service.
   *
   * @param options.baseUrl Base URL for the Piper TTS HTTP server.
   * @param options.fetch `fetch` used for HTTP requests (upstream: an
   *   aiohttp ClientSession).
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent TTSService.
   */
  constructor(options: PiperHttpTTSServiceOptions) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof PiperHttpTTSService).Settings({
      model: null,
      voice: null,
      language: null,
    });

    // 2. The deprecated voice_id argument is not ported.
    // 3. (No step 3, as there's no params object to apply)

    // 4. Apply settings delta (canonical API, always wins)
    if (options.settings !== undefined && options.settings !== null) {
      defaultSettings.applyUpdate(options.settings);
    }

    super({
      ...options,
      pushStartFrame: true,
      pushStopFrames: true,
      settings: defaultSettings,
    });

    let baseUrl = options.baseUrl;
    if (baseUrl.endsWith("/")) {
      logger.warning("Base URL ends with a slash, this is not allowed.");
      baseUrl = baseUrl.slice(0, -1);
    }

    this._baseUrl = baseUrl;
    this._fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Check if this service can generate processing metrics.
   *
   * @returns True, as Piper service supports metrics generation.
   */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Generate speech from text using Piper's HTTP API.
   *
   * @param text The text to convert to speech.
   * @param contextId Unique identifier for this TTS context.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    const headers = {
      "Content-Type": "application/json",
    };
    try {
      const data = {
        text,
        voice: this._settings.voice,
      };

      const response = await abortable(
        this._fetch(this._baseUrl, {
          method: "POST",
          headers,
          body: pyJsonDumps(data),
          signal: currentSignal(),
        }),
      );
      if (response.status !== 200) {
        const error = await abortable(response.text());
        yield new ErrorFrame({
          error: `Error getting audio (status: ${response.status}, error: ${error})`,
        });
        yield new TTSStoppedFrame({ contextId });
        return;
      }

      await this.startTtsUsageMetrics(text);

      const CHUNK_SIZE = this.chunkSize;

      for await (const frame of this._streamAudioFramesFromIterator(
        iterChunked(response.body, CHUNK_SIZE),
        {
          stripWavHeader: true,
          contextId,
        },
      )) {
        await this.stopTtfbMetrics();
        yield frame;
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}
