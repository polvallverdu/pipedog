// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/kokoro/tts.py

/**
 * Kokoro TTS service implementation using kokoro-onnx.
 *
 * Porting notes:
 * - kokoro-onnx is reimplemented in `kokoro_onnx.ts` (same model and voice
 *   files, same phonemization, batching and trimming) on `@pipedog/onnx` and
 *   `@pipedog/espeak-ng`.
 * - The deprecated `voice_id` argument and `InputParams` / `params` are not
 *   ported; use `settings`.
 * - DIVERGENCE: upstream downloads and loads the model in the constructor.
 *   Loading is asynchronous here, so the constructor only resolves options
 *   and checks that a voice is set; the files are downloaded and loaded in
 *   `start()` (or on first use), once. An unknown voice is reported then.
 * - DIVERGENCE: the default cache directory is `modelCacheDir("kokoro")`
 *   (`~/.cache/pipedog/kokoro`, see `@pipedog/onnx`), not
 *   `~/.cache/pipecat/kokoro-onnx`.
 */

import { abortable, rethrowIfCancelled } from "@pipedog/asyncio";
import type { BaseAudioResampler } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { createStreamResampler } from "@pipedog/core/audio/utils";
import {
  ErrorFrame,
  type Frame,
  type StartFrame,
  TTSAudioRawFrame,
} from "@pipedog/core/frames/frames";
import { TTSSettings, type TTSSettingsOptions } from "@pipedog/core/services/settings";
import { TTSService, type TTSServiceOptions } from "@pipedog/core/services/tts_service";
import { Language, resolveLanguage } from "@pipedog/core/transcriptions/language";
import { logger } from "@pipedog/core/utils/logger";
import { installTracedTts } from "@pipedog/core/utils/tracing/service_decorators";
import { assertGiven, NOT_GIVEN, type NotGiven, requireGiven } from "@pipedog/core/utils/types";
import { downloadModelFile, fileExists, modelCacheDir, type OnnxBackend } from "@pipedog/onnx";
import { Kokoro } from "./kokoro_onnx.ts";

/** Name of the cache directory under the pipedog cache (`modelCacheDir`). */
export const KOKORO_CACHE_DIR_NAME = "kokoro";
export const KOKORO_MODEL_URL =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx";
export const KOKORO_VOICES_URL =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";
/** File names of the default model and voices in the cache directory. */
export const KOKORO_MODEL_FILE = "kokoro-v1.0.onnx";
export const KOKORO_VOICES_FILE = "voices-v1.0.bin";

/**
 * The default cache directory for Kokoro's files.
 *
 * DIVERGENCE: upstream's `KOKORO_CACHE_DIR` is `~/.cache/pipecat/kokoro-onnx`.
 */
export function kokoroCacheDir(): Promise<string> {
  return modelCacheDir(KOKORO_CACHE_DIR_NAME);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function joinPath(dir: string, file: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${file}` : `${dir}/${file}`;
}

/** Download a file from a URL to a destination path. */
async function _downloadFile(url: string, dest: string, fetchFn?: typeof fetch): Promise<void> {
  logger.debug(`Downloading ${url} to ${dest}...`);
  await downloadModelFile(url, dest, { fetch: fetchFn });
  logger.debug(`Downloaded ${dest}`);
}

/**
 * Download model files if they don't exist.
 *
 * @param modelPath Where the model should be.
 * @param voicesPath Where the voices file should be.
 * @param options.modelUrl / options.voicesUrl Where to download them from.
 */
export async function _ensureModelFiles(
  modelPath: string,
  voicesPath: string,
  options: { modelUrl?: string; voicesUrl?: string; fetch?: typeof fetch } = {},
): Promise<void> {
  if (!(await fileExists(modelPath))) {
    await _downloadFile(options.modelUrl ?? KOKORO_MODEL_URL, modelPath, options.fetch);
  }
  if (!(await fileExists(voicesPath))) {
    await _downloadFile(options.voicesUrl ?? KOKORO_VOICES_URL, voicesPath, options.fetch);
  }
}

/**
 * Convert a Language enum to kokoro-onnx language code.
 *
 * kokoro-onnx phonemizes through espeak-ng, so these are espeak-ng voice names
 * rather than ISO codes. They differ for Mandarin (`cmn`, not `zh`) and
 * French, which espeak-ng only offers per-region (`fr-fr`, no bare `fr`);
 * an unsupported name fails at synthesis time.
 *
 * @param language The Language enum value to convert.
 * @returns The corresponding kokoro-onnx locale code.
 */
export function languageToKokoroLanguage(language: Language): string {
  const LANGUAGE_MAP: Partial<Record<Language, string>> = {
    [Language.EN]: "en-us",
    [Language.EN_US]: "en-us",
    [Language.EN_GB]: "en-gb",
    [Language.ES]: "es",
    [Language.FR]: "fr-fr",
    [Language.FR_BE]: "fr-be",
    [Language.FR_CA]: "fr-fr",
    [Language.FR_CH]: "fr-ch",
    [Language.FR_FR]: "fr-fr",
    [Language.HI]: "hi",
    [Language.IT]: "it",
    [Language.JA]: "ja",
    [Language.PT]: "pt",
    [Language.PT_BR]: "pt-br",
    [Language.CMN]: "cmn",
    [Language.YUE]: "yue",
    [Language.ZH]: "cmn",
    [Language.ZH_CN]: "cmn",
    [Language.ZH_HK]: "cmn",
    [Language.ZH_TW]: "cmn",
  };

  return resolveLanguage(language, LANGUAGE_MAP, true);
}

export interface KokoroTTSSettingsOptions extends TTSSettingsOptions {
  /** Speech rate multiplier (0.5-2.0). Defaults to 1.0. */
  speed?: number | NotGiven;
}

/**
 * Settings for KokoroTTSService.
 *
 * - `speed`: speech rate multiplier (0.5-2.0). Defaults to 1.0.
 */
export class KokoroTTSSettings extends TTSSettings {
  speed: number | NotGiven = NOT_GIVEN;

  constructor(options: KokoroTTSSettingsOptions = {}) {
    super(options);
    this._assignOptions(options);
  }
}

export interface KokoroTTSServiceOptions extends TTSServiceOptions {
  /** Path to the kokoro ONNX model file. Defaults to the auto-downloaded file. */
  modelPath?: string | null;
  /** Path to the voices binary file. Defaults to the auto-downloaded file. */
  voicesPath?: string | null;
  /**
   * Directory for the auto-downloaded files (default `kokoroCacheDir()`).
   * Not upstream.
   */
  cacheDir?: string | null;
  /** Where to download a missing model from (default `KOKORO_MODEL_URL`). Not upstream. */
  modelUrl?: string | null;
  /** Where to download a missing voices file from (default `KOKORO_VOICES_URL`). Not upstream. */
  voicesUrl?: string | null;
  /** `fetch` for downloads (default: the global `fetch`). Not upstream. */
  fetch?: typeof fetch | null;
  /** The ONNX backend (default: `createOnnxBackend()`). Not upstream. */
  backend?: OnnxBackend | Promise<OnnxBackend> | null;
  /** Share the model session and voices across services (default `true`). Not upstream. */
  shareSession?: boolean;
  /** Runtime-updatable settings. */
  settings?: KokoroTTSSettings | null;
}

/**
 * Kokoro TTS service implementation.
 *
 * Provides local text-to-speech synthesis using kokoro-onnx.
 * Automatically downloads model files on first use.
 */
export class KokoroTTSService extends TTSService {
  static Settings: typeof KokoroTTSSettings = KokoroTTSSettings;
  declare protected _settings: KokoroTTSSettings;

  static {
    installTracedTts(KokoroTTSService.prototype, "runTts");
  }

  protected _kokoro: Kokoro | null = null;
  protected _kokoroLoading: Promise<Kokoro> | null = null;
  protected override _resampler: BaseAudioResampler;
  readonly #options: KokoroTTSServiceOptions;

  /**
   * Initialize the Kokoro TTS service.
   *
   * @param options.modelPath Path to the kokoro ONNX model file. Defaults to
   *   auto-downloaded file.
   * @param options.voicesPath Path to the voices binary file. Defaults to
   *   auto-downloaded file.
   * @param options.settings Runtime-updatable settings.
   *   Other options are passed to the parent `TTSService`.
   */
  constructor(options: KokoroTTSServiceOptions = {}) {
    // 1. Initialize default_settings with hardcoded defaults
    const defaultSettings = new (new.target as typeof KokoroTTSService).Settings({
      model: null,
      voice: null,
      language: Language.EN,
      speed: 1.0,
    });

    // 2./3. The deprecated voice_id and params arguments are not ported.

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

    // DIVERGENCE: checked before the files are downloaded and loaded (later).
    requireGiven(this._settings.voice, "Kokoro TTS voice");

    this._resampler = createStreamResampler();
  }

  /**
   * Download (if needed) and load the model and voices, once.
   *
   * DIVERGENCE: upstream does this in the constructor.
   *
   * @throws If the configured voice is not in the voices file.
   */
  async _loadKokoro(): Promise<Kokoro> {
    if (this._kokoro) return this._kokoro;
    if (!this._kokoroLoading) {
      const loading = (async () => {
        const options = this.#options;
        let modelFile = options.modelPath ?? null;
        let voices = options.voicesPath ?? null;
        if (!modelFile || !voices) {
          const dir = options.cacheDir ?? (await kokoroCacheDir());
          modelFile ??= joinPath(dir, KOKORO_MODEL_FILE);
          voices ??= joinPath(dir, KOKORO_VOICES_FILE);
        }

        await _ensureModelFiles(modelFile, voices, {
          modelUrl: options.modelUrl ?? undefined,
          voicesUrl: options.voicesUrl ?? undefined,
          fetch: options.fetch ?? undefined,
        });

        const kokoro = await Kokoro.load(modelFile, voices, {
          backend: options.backend,
          shareSession: options.shareSession,
        });

        const voice = requireGiven(this._settings.voice, "Kokoro TTS voice");
        if (!kokoro.voices.has(voice)) {
          throw new Error(`Kokoro TTS voice '${voice}' is not in the voices file`);
        }
        this._kokoro = kokoro;
        return kokoro;
      })();
      this._kokoroLoading = loading;
      // A failed load is retried on the next use.
      loading.catch(() => {
        if (this._kokoroLoading === loading) this._kokoroLoading = null;
      });
    }
    return await this._kokoroLoading;
  }

  /** Indicate that this service supports TTFB and usage metrics. */
  override canGenerateMetrics(): boolean {
    return true;
  }

  /**
   * Convert a Language enum to kokoro-onnx language format.
   *
   * @param language The language to convert.
   * @returns The kokoro-onnx language code.
   */
  override languageToServiceLanguage(language: Language): string | null {
    return languageToKokoroLanguage(language);
  }

  /**
   * Start the service and load the model.
   *
   * DIVERGENCE: the model is loaded here (upstream: in the constructor). A
   * failure is reported as an error and retried on the first synthesis.
   */
  override async start(frame: StartFrame): Promise<void> {
    await super.start(frame);
    try {
      await abortable(this._loadKokoro());
    } catch (e) {
      rethrowIfCancelled(e);
      await this.pushError(`Failed to load Kokoro: ${errorMessage(e)}`, { exception: e });
    }
  }

  /**
   * Synthesize speech from text using kokoro-onnx.
   *
   * Uses the async streaming API to generate audio frames.
   *
   * @param text The text to synthesize.
   * @param contextId Unique identifier for this TTS context.
   */
  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    try {
      await this.startTtsUsageMetrics(text);

      const voice = requireGiven(this._settings.voice, "Kokoro TTS voice");
      const lang = requireGiven(this._settings.language, "Kokoro TTS language");
      const speed = assertGiven(this._settings.speed);
      const kokoro = await abortable(this._loadKokoro());
      const stream = kokoro.createStream(text, { voice, lang: String(lang), speed });

      try {
        while (true) {
          const next = await abortable(stream.next());
          if (next.done) break;
          const [samples, sampleRate] = next.value;
          await this.stopTtfbMetrics();

          // (samples * 32767).astype(np.int16): a float32 product, truncated and
          // wrapped like numpy's cast.
          const pcm = new Int16Array(samples.length);
          for (let i = 0; i < samples.length; i++)
            pcm[i] = Math.fround((samples[i] as number) * 32767);
          const audioInt16 = new Uint8Array(pcm.buffer);
          const audioData = await this._resampler.resample(audioInt16, sampleRate, this.sampleRate);

          yield new TTSAudioRawFrame({
            audio: audioData,
            sampleRate: this.sampleRate,
            numChannels: 1,
            contextId,
          });
        }
      } finally {
        // Stop the stream if we leave early (cancelled or failed). Not awaited:
        // the batch already running finishes in the background, no further
        // batch is started.
        stream.return(undefined).catch(() => {});
      }
    } catch (e) {
      rethrowIfCancelled(e);
      yield new ErrorFrame({ error: `Unknown error occurred: ${errorMessage(e)}` });
    } finally {
      await this.stopTtfbMetrics();
    }
  }
}
