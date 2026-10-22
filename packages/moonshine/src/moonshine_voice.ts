// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Moonshine speech-to-text models, the part of the `moonshine_voice` Python
 * package (moonshine-ai/moonshine v0.1.5) that pipecat's `MoonshineSTTService`
 * uses, reimplemented on `@pipedog/onnx`.
 *
 * It runs the same quantized `.ort` model files from download.moonshine.ai, the
 * same tokenizer and the same decoding rules as Moonshine's C++ core (see
 * `moonshine_voice_engine.ts`):
 *
 * - `getModelForLanguage(language, modelArch?)` picks a model from Moonshine's
 *   catalog and returns `[modelPath, modelArch]`. The path is in the model
 *   cache; the files download on first use (or call `downloadModel()`).
 * - `new Transcriber(modelPath, modelArch)` loads the model on first use;
 *   `transcribeWithoutStreaming(audio, sampleRate)` splits the audio into
 *   speech segments with Silero VAD, as Moonshine does, and returns one
 *   transcript line per segment.
 * - `supportedLanguages()`, `supportedLanguagesFriendly()`, `stringToModelArch()`
 *   and `modelArchToString()` as in `moonshine_voice`.
 *
 * Every architecture is supported: the non-streaming `tiny` and `base`, and the
 * streaming `tiny-streaming`, `base-streaming`, `small-streaming` and
 * `medium-streaming` (decoded in one pass per segment, as
 * `transcribe_without_streaming` does).
 *
 * @example
 * ```ts
 * import { getModelForLanguage, Transcriber } from "@pipedog/moonshine/moonshine_voice";
 * const [path, arch] = getModelForLanguage("en", ModelArch.TINY);
 * const transcriber = new Transcriber(path, arch);
 * const transcript = await transcriber.transcribeWithoutStreaming(samples, 16000);
 * console.log(transcript.lines.map((l) => l.text).join(" "));
 * ```
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { defaultSileroModelUrl } from "@pipedog/audio-silero/silero";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { logger } from "@pipedog/core/utils/logger";
import {
  createOnnxBackend,
  downloadModelFile,
  type OnnxBackend,
  type OnnxModelSource,
} from "@pipedog/onnx";
import {
  appendPathComponent,
  DirectoryModelFiles,
  INTERNAL_SAMPLE_RATE,
  MemoryModelFiles,
  type ModelFiles,
  MoonshineModel,
  MoonshineStreamingModel,
  type MoonshineStreamingState,
  type SileroVad,
  sanitizeText,
  sharedSileroVad,
  VoiceActivityDetector,
} from "./moonshine_voice_engine.ts";
import { MODEL_FILE_METADATA } from "./moonshine_voice_files.ts";

// ---------------------------------------------------------------------------
// Architectures

/** Model architecture types (`moonshine_voice.ModelArch`, an `IntEnum`). */
export const ModelArch = {
  TINY: 0,
  BASE: 1,
  TINY_STREAMING: 2,
  BASE_STREAMING: 3,
  SMALL_STREAMING: 4,
  MEDIUM_STREAMING: 5,
} as const;
export type ModelArch = (typeof ModelArch)[keyof typeof ModelArch];

const ARCH_STRINGS: Readonly<Record<ModelArch, string>> = {
  [ModelArch.TINY]: "tiny",
  [ModelArch.BASE]: "base",
  [ModelArch.TINY_STREAMING]: "tiny-streaming",
  [ModelArch.BASE_STREAMING]: "base-streaming",
  [ModelArch.SMALL_STREAMING]: "small-streaming",
  [ModelArch.MEDIUM_STREAMING]: "medium-streaming",
};

/**
 * Convert a model architecture to a string.
 *
 * @throws Error If `modelArch` is not a model architecture (upstream: ValueError).
 */
export function modelArchToString(modelArch: ModelArch): string {
  const name = ARCH_STRINGS[modelArch];
  if (name === undefined) throw new Error(`Invalid model architecture: ${modelArch}`);
  return name;
}

/**
 * Convert a string to a model architecture.
 *
 * @throws Error If the string names no architecture (upstream: ValueError).
 */
export function stringToModelArch(modelArchString: string): ModelArch {
  for (const [arch, name] of Object.entries(ARCH_STRINGS)) {
    if (name === modelArchString) return Number(arch) as ModelArch;
  }
  throw new Error(`Invalid model architecture string: ${modelArchString}`);
}

/** Whether `modelArch` is one of the streaming architectures. */
export function isStreamingModelArch(modelArch: number): boolean {
  return (
    modelArch === ModelArch.TINY_STREAMING ||
    modelArch === ModelArch.BASE_STREAMING ||
    modelArch === ModelArch.SMALL_STREAMING ||
    modelArch === ModelArch.MEDIUM_STREAMING
  );
}

// ---------------------------------------------------------------------------
// Catalog (core/moonshine-model-catalog.cpp)

const CDN_MODEL_BASE = "https://download.moonshine.ai/model";
// Re-quantized releases go to new dated directories, so a cache keyed by URL
// never reuses stale weights.
const STREAMING_QUANTIZED_DIR = "/quantized_26_08_21"; // English
const JAPANESE_STREAMING_QUANTIZED_DIR = "/quantized_26_08_23";
const OTHER_STREAMING_QUANTIZED_DIR = "/quantized_26_08_24"; // de, es, vi, ar, zh, tl

interface CatalogLanguage {
  code: string;
  englishName: string;
  models: { modelArch: ModelArch; downloadUrl: string }[];
}

const nonStreaming = (name: string) => `${CDN_MODEL_BASE}/${name}/quantized/${name}`;
const streaming = (name: string, dir: string) => `${CDN_MODEL_BASE}/${name}${dir}`;

/** Languages and their models, best (default) first, in Moonshine's catalog order. */
const STT_CATALOG: readonly CatalogLanguage[] = [
  {
    code: "ar",
    englishName: "Arabic",
    models: [
      {
        modelArch: ModelArch.TINY_STREAMING,
        downloadUrl: streaming("tiny-streaming-ar", OTHER_STREAMING_QUANTIZED_DIR),
      },
      { modelArch: ModelArch.BASE, downloadUrl: nonStreaming("base-ar") },
    ],
  },
  {
    code: "es",
    englishName: "Spanish",
    models: [
      {
        modelArch: ModelArch.SMALL_STREAMING,
        downloadUrl: streaming("small-streaming-es", OTHER_STREAMING_QUANTIZED_DIR),
      },
      {
        modelArch: ModelArch.TINY_STREAMING,
        downloadUrl: streaming("tiny-streaming-es", OTHER_STREAMING_QUANTIZED_DIR),
      },
      { modelArch: ModelArch.BASE, downloadUrl: nonStreaming("base-es") },
    ],
  },
  {
    code: "de",
    englishName: "German",
    models: [
      {
        modelArch: ModelArch.SMALL_STREAMING,
        downloadUrl: streaming("small-streaming-de", OTHER_STREAMING_QUANTIZED_DIR),
      },
      {
        modelArch: ModelArch.TINY_STREAMING,
        downloadUrl: streaming("tiny-streaming-de", OTHER_STREAMING_QUANTIZED_DIR),
      },
    ],
  },
  {
    code: "en",
    englishName: "English",
    models: [
      {
        modelArch: ModelArch.MEDIUM_STREAMING,
        downloadUrl: streaming("medium-streaming-en", STREAMING_QUANTIZED_DIR),
      },
      {
        modelArch: ModelArch.SMALL_STREAMING,
        downloadUrl: streaming("small-streaming-en", STREAMING_QUANTIZED_DIR),
      },
      { modelArch: ModelArch.BASE, downloadUrl: nonStreaming("base-en") },
      {
        modelArch: ModelArch.TINY_STREAMING,
        downloadUrl: streaming("tiny-streaming-en", STREAMING_QUANTIZED_DIR),
      },
      { modelArch: ModelArch.TINY, downloadUrl: nonStreaming("tiny-en") },
    ],
  },
  {
    code: "ja",
    englishName: "Japanese",
    models: [
      {
        modelArch: ModelArch.SMALL_STREAMING,
        downloadUrl: streaming("small-streaming-ja", JAPANESE_STREAMING_QUANTIZED_DIR),
      },
      {
        modelArch: ModelArch.TINY_STREAMING,
        downloadUrl: streaming("tiny-streaming-ja", JAPANESE_STREAMING_QUANTIZED_DIR),
      },
      { modelArch: ModelArch.BASE, downloadUrl: nonStreaming("base-ja") },
      { modelArch: ModelArch.TINY, downloadUrl: nonStreaming("tiny-ja") },
    ],
  },
  {
    code: "ko",
    englishName: "Korean",
    models: [{ modelArch: ModelArch.TINY, downloadUrl: nonStreaming("tiny-ko") }],
  },
  {
    code: "vi",
    englishName: "Vietnamese",
    models: [
      {
        modelArch: ModelArch.TINY_STREAMING,
        downloadUrl: streaming("tiny-streaming-vi", OTHER_STREAMING_QUANTIZED_DIR),
      },
      { modelArch: ModelArch.BASE, downloadUrl: nonStreaming("base-vi") },
    ],
  },
  {
    code: "uk",
    englishName: "Ukrainian",
    models: [{ modelArch: ModelArch.BASE, downloadUrl: nonStreaming("base-uk") }],
  },
  {
    code: "zh",
    englishName: "Chinese",
    models: [
      {
        modelArch: ModelArch.TINY_STREAMING,
        downloadUrl: streaming("tiny-streaming-zh", OTHER_STREAMING_QUANTIZED_DIR),
      },
      { modelArch: ModelArch.BASE, downloadUrl: nonStreaming("base-zh") },
    ],
  },
  {
    code: "tl",
    englishName: "Tagalog",
    models: [
      {
        modelArch: ModelArch.TINY_STREAMING,
        downloadUrl: streaming("tiny-streaming-tl", OTHER_STREAMING_QUANTIZED_DIR),
      },
    ],
  },
];

/** A catalog entry for one language and architecture. */
export interface ModelInfo {
  modelArch: ModelArch;
  /** The directory URL the model's files are downloaded from. */
  downloadUrl: string;
  /** Whether this is the language's default (first-listed) model. */
  isDefault: boolean;
  /** The language code. */
  language: string;
}

/** The files a model directory holds (`stt_component_files`, without word-timestamp decoders). */
export function modelComponentFiles(modelArch: ModelArch): string[] {
  if (isStreamingModelArch(modelArch)) {
    return [
      "adapter.ort",
      "cross_kv.ort",
      "decoder_kv.ort",
      "encoder.ort",
      "frontend.model.ort",
      "frontend.weights.ort",
      "streaming_config.json",
      "tokenizer.bin",
    ];
  }
  return ["encoder_model.ort", "decoder_model_merged.ort", "tokenizer.bin"];
}

/** Language codes Moonshine publishes models for. */
export function supportedLanguages(): string[] {
  return STT_CATALOG.map((language) => language.code);
}

/** The supported languages as `"ar (Arabic), es (Spanish), ..."`. */
export function supportedLanguagesFriendly(): string {
  return STT_CATALOG.map((language) => `${language.code} (${language.englishName})`).join(", ");
}

/**
 * Resolve a language (code, or English name in any case) and optional
 * architecture to a catalog entry. Without an architecture, the language's
 * default model.
 *
 * @throws Error If the language or the architecture for it is not in the catalog
 *   (upstream: ValueError).
 */
export function findModelInfo(language = "en", modelArch: ModelArch | null = null): ModelInfo {
  let entry = STT_CATALOG.find((candidate) => candidate.code === language);
  if (entry === undefined) {
    entry = STT_CATALOG.find(
      (candidate) => candidate.englishName.toLowerCase() === language.toLowerCase(),
    );
  }
  if (entry === undefined) {
    throw new Error(
      `Language not found: ${language}. Supported languages: ${supportedLanguagesFriendly()}`,
    );
  }
  const models = entry.models.map((model, i) => ({
    ...model,
    isDefault: i === 0,
    language: entry.code,
  }));
  if (modelArch === null || modelArch === undefined) return models[0] as ModelInfo;
  const found = models.find((model) => model.modelArch === modelArch);
  if (found === undefined) {
    const available = models.map((model) => modelArchToString(model.modelArch)).join(", ");
    throw new Error(
      `Model not found for language: ${language} and model arch: ${modelArch}. Available models: ${available}`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Model cache and downloads

/** Where `getModelForLanguage` puts models. */
export interface ModelCacheOptions {
  /**
   * The cache root. Models go in
   * `<cacheRoot>/download.moonshine.ai/model/<model>/...` (the URL without its
   * scheme, as moonshine_voice does). Default: `$PIPEDOG_CACHE_DIR/moonshine`,
   * else `$XDG_CACHE_HOME/pipedog/moonshine`, else `~/.cache/pipedog/moonshine`.
   */
  cacheRoot?: string;
}

function env(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return value ? value : undefined;
}

/** The default cache root, computed without touching the filesystem. */
export function defaultModelCacheRoot(): string {
  const root = env("PIPEDOG_CACHE_DIR");
  if (root) return appendPathComponent(root, "moonshine");
  const xdg = env("XDG_CACHE_HOME");
  if (xdg) return appendPathComponent(appendPathComponent(xdg, "pipedog"), "moonshine");
  const home = env("HOME") ?? env("USERPROFILE");
  if (!home) {
    throw new Error(
      "Cannot locate a cache directory for Moonshine models (no HOME): pass cacheRoot",
    );
  }
  return [home, ".cache", "pipedog", "moonshine"].reduce(appendPathComponent);
}

/** The local directory for a model's download URL. */
export function modelPathForUrl(downloadUrl: string, cacheRoot?: string): string {
  const root = cacheRoot ?? defaultModelCacheRoot();
  return appendPathComponent(root, downloadUrl.replace(/^https?:\/\//, ""));
}

interface PendingDownload {
  downloadUrl: string;
  files: string[];
}

/** Model directories handed out by `getModelForLanguage`, so `Transcriber` can download them. */
const downloadsByPath = new Map<string, PendingDownload>();

/**
 * Pick the transcription model for a language and return
 * `[modelPath, modelArch]`.
 *
 * DIVERGENCE: upstream downloads the model here (blocking). This returns the
 * model's directory in the cache right away and leaves the download to the
 * `Transcriber` that loads it (or to `downloadModel()`), so it can be called
 * from a constructor. Upstream also prefetches the optional English spelling
 * model, which `transcribeWithoutStreaming` never uses; that is not done.
 *
 * @throws Error If Moonshine has no model for the language and architecture
 *   (upstream: ValueError).
 */
export function getModelForLanguage(
  wantedLanguage = "en",
  wantedModelArch: ModelArch | null = null,
  options: ModelCacheOptions = {},
): [string, ModelArch] {
  const info = findModelInfo(wantedLanguage, wantedModelArch);
  if (wantedLanguage !== "en") {
    logger.warning(
      "Using a model released under the non-commercial Moonshine Community License. " +
        "See https://www.moonshine.ai/license for details.",
    );
  }
  const path = modelPathForUrl(info.downloadUrl, options.cacheRoot);
  downloadsByPath.set(path, {
    downloadUrl: info.downloadUrl,
    files: modelComponentFiles(info.modelArch),
  });
  return [path, info.modelArch];
}

/** Options for downloading model files. */
export interface ModelDownloadOptions extends ModelCacheOptions {
  /** `fetch` to download with (default: the global `fetch`). */
  fetch?: typeof fetch;
  /** Abort the download. */
  signal?: AbortSignal;
  /** Progress: the file being fetched and its bytes received / total. */
  onProgress?: (file: string, received: number, total: number) => void;
}

/**
 * Pick the model for a language like `getModelForLanguage`, and download its
 * files now (skipping those already in the cache).
 */
export async function downloadModel(
  wantedLanguage = "en",
  wantedModelArch: ModelArch | null = null,
  options: ModelDownloadOptions = {},
): Promise<[string, ModelArch]> {
  const [path, arch] = getModelForLanguage(wantedLanguage, wantedModelArch, options);
  const pending = downloadsByPath.get(path) as PendingDownload;
  await downloadModelFiles(pending.downloadUrl, path, pending.files, options);
  return [path, arch];
}

const METADATA = new Map(
  MODEL_FILE_METADATA.map(([path, size, crc]) => [`${CDN_MODEL_BASE}/${path}`, { size, crc }]),
);

// Held in a variable so bundlers leave the import alone (Bun, Node, Deno only).
const NODE_FS = "node:fs/promises";

interface NodeFs {
  stat(path: string): Promise<{ size: number; isFile(): boolean }>;
  readFile(path: string): Promise<Uint8Array>;
  rm(path: string, options: { force: boolean }): Promise<void>;
}

let crcTable: Uint32Array | null = null;

/** CRC32C (Castagnoli) of `data`, as GCS reports it: base64 of the big-endian value. */
export function crc32c(data: Uint8Array): string {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crcTable[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return bytesToBase64(
    new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]),
  );
}

/**
 * Download `files` from `downloadUrl` into `dir`, unless they are already
 * there with the expected size. Fresh downloads are checked against the size
 * and CRC32C Moonshine publishes for them.
 */
export async function downloadModelFiles(
  downloadUrl: string,
  dir: string,
  files: readonly string[],
  options: ModelDownloadOptions = {},
): Promise<void> {
  const fs = (await import(NODE_FS)) as NodeFs;
  for (const name of files) {
    const url = `${downloadUrl}/${name}`;
    const dest = appendPathComponent(dir, name);
    const meta = METADATA.get(url);
    let existing: number | null = null;
    try {
      const st = await fs.stat(dest);
      if (st.isFile()) existing = st.size;
    } catch {
      existing = null;
    }
    if (existing !== null && existing > 0 && (meta === undefined || existing === meta.size)) {
      continue;
    }
    logger.debug(`Downloading Moonshine model file ${url}`);
    await downloadModelFile(url, dest, {
      force: existing !== null,
      fetch: options.fetch,
      signal: options.signal,
      onProgress: options.onProgress
        ? (received, total) => options.onProgress?.(name, received, total)
        : undefined,
    });
    if (meta !== undefined) {
      const data = await fs.readFile(dest);
      const problem =
        data.length !== meta.size
          ? `size ${data.length}, expected ${meta.size}`
          : crc32c(data) !== meta.crc
            ? "CRC32C mismatch"
            : null;
      if (problem !== null) {
        await fs.rm(dest, { force: true });
        throw new Error(`Downloaded Moonshine model file ${url} is corrupt (${problem})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Transcriber

/** A single line of transcription (one speech segment). */
export interface TranscriptLine {
  text: string;
  /** Seconds from the start of the audio. */
  startTime: number;
  /** Seconds. */
  duration: number;
  lineId: bigint;
  isComplete: boolean;
  isUpdated: boolean;
  isNew: boolean;
  hasTextChanged: boolean;
  /** The segment's 16 kHz audio (when `returnAudioData`, the default). */
  audioData: Float32Array | null;
  lastTranscriptionLatencyMs: number;
}

/** A complete transcript containing multiple lines. */
export interface Transcript {
  lines: TranscriptLine[];
}

/** Options for `Transcriber` (the C API options that apply, plus the runtime). */
export interface TranscriberOptions {
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
  /**
   * The model's files in memory, by file name (`"tokenizer.bin"`, ...), instead
   * of reading `modelPath` from disk; for runtimes without a filesystem.
   */
  files?: Readonly<Record<string, Uint8Array>>;
  /**
   * The Silero VAD model (default: the `silero_vad.onnx` shipped with
   * `@pipedog/audio-silero`, the same model Moonshine embeds).
   */
  vadModel?: OnnxModelSource;
  /** Share inference sessions across transcribers (default true; the graphs keep no state). */
  shareSessions?: boolean;
  /** Download a missing model handed out by `getModelForLanguage` (default true). */
  download?: boolean;
  /** `fetch` for downloads. */
  fetch?: typeof fetch;
  /** Decoding budget: tokens per second of audio (default 6.5). */
  maxTokensPerSecond?: number;
  /** VAD speech threshold (default 0.5; 0 treats all audio as speech). */
  vadThreshold?: number;
  /** Seconds of VAD probabilities averaged (default 0.5). */
  vadWindowDuration?: number;
  /** VAD hop in samples (default 512). */
  vadHopSize?: number;
  /** Samples before the detected speech start included in a segment (default 8192). */
  vadLookBehindSampleCount?: number;
  /** Maximum segment length in seconds (default 15). */
  vadMaxSegmentDuration?: number;
  /** Return each line's audio (default true). */
  returnAudioData?: boolean;
}

type LoadedModel =
  | { kind: "non-streaming"; model: MoonshineModel }
  | { kind: "streaming"; model: MoonshineStreamingModel; state: MoonshineStreamingState };

const VALID_MODEL_ARCHS: readonly number[] = Object.values(ModelArch);

function randomLineIdStart(): bigint {
  const words = new Uint32Array(2);
  globalThis.crypto.getRandomValues(words);
  return (BigInt(words[0] as number) << 32n) | BigInt(words[1] as number);
}

/**
 * Main transcriber class for Moonshine Voice.
 *
 * DIVERGENCE: upstream loads the model in the constructor. Here the
 * constructor only validates its arguments; the model (and the Silero VAD)
 * load on the first transcription or on `load()`, and a model handed out by
 * `getModelForLanguage` is downloaded then if it is not in the cache.
 */
export class Transcriber {
  readonly modelPath: string;
  readonly modelArch: ModelArch;
  readonly options: TranscriberOptions;

  readonly #vad: VoiceActivityDetector;
  #backend: Promise<OnnxBackend> | null = null;
  #loading: Promise<LoadedModel> | null = null;
  #closed = false;
  #tail: Promise<unknown> = Promise.resolve();
  #nextLineId = randomLineIdStart();

  /**
   * Initialize a transcriber.
   *
   * @param modelPath Path to the directory containing model files.
   * @param modelArch Model architecture to use.
   * @param options Runtime and advanced options.
   * @throws Error If `modelArch` is not a model architecture.
   */
  constructor(
    modelPath: string,
    modelArch: ModelArch = ModelArch.BASE,
    options: TranscriberOptions = {},
  ) {
    if (modelPath === null || modelPath === undefined) throw new Error("Model path is null");
    if (!VALID_MODEL_ARCHS.includes(modelArch)) {
      throw new Error(`Invalid model architecture: ${modelArch}`);
    }
    this.modelPath = modelPath;
    this.modelArch = modelArch;
    this.options = options;
    const hopSize = options.vadHopSize ?? 512;
    const windowSize = Math.ceil(
      ((options.vadWindowDuration ?? 0.5) * INTERNAL_SAMPLE_RATE) / hopSize,
    );
    this.#vad = new VoiceActivityDetector(
      () => this.#sileroVad(),
      options.vadThreshold ?? 0.5,
      windowSize,
      hopSize,
      options.vadLookBehindSampleCount ?? 8192,
      Math.round((options.vadMaxSegmentDuration ?? 15) * INTERNAL_SAMPLE_RATE),
    );
  }

  #getBackend(): Promise<OnnxBackend> {
    if (this.#backend === null) {
      this.#backend = Promise.resolve(this.options.backend ?? createOnnxBackend());
      this.#backend.catch(() => {
        this.#backend = null;
      });
    }
    return this.#backend;
  }

  async #sileroVad(): Promise<SileroVad> {
    return sharedSileroVad(
      await this.#getBackend(),
      this.options.vadModel ?? defaultSileroModelUrl(),
    );
  }

  /**
   * Load (downloading first if needed) the model and the VAD. Called by the
   * first transcription; call it earlier to load ahead of time. A failed load
   * is retried by the next call.
   */
  load(): Promise<void> {
    return this.#load().then(() => undefined);
  }

  #load(): Promise<LoadedModel> {
    if (this.#closed) return Promise.reject(new Error("Transcriber is not initialized"));
    if (this.#loading === null) {
      const loading = this.#loadModel();
      this.#loading = loading;
      loading.catch(() => {
        if (this.#loading === loading) this.#loading = null;
      });
    }
    return this.#loading;
  }

  async #loadModel(): Promise<LoadedModel> {
    const pending = downloadsByPath.get(this.modelPath);
    if (this.options.files === undefined && pending && (this.options.download ?? true)) {
      await downloadModelFiles(pending.downloadUrl, this.modelPath, pending.files, {
        fetch: this.options.fetch,
      });
    }
    const files: ModelFiles =
      this.options.files !== undefined
        ? new MemoryModelFiles(this.options.files)
        : new DirectoryModelFiles(this.modelPath);
    if (!(await files.rootExists())) {
      throw new Error(`Model directory does not exist at path '${this.modelPath}'`);
    }
    if (!(await files.exists("tokenizer.bin"))) {
      throw new Error(
        `Required tokenizer file does not exist at path '${files.pathOf("tokenizer.bin")}'`,
      );
    }
    const backend = await this.#getBackend();
    const loadOptions = {
      backend,
      shareSessions: this.options.shareSessions ?? true,
      maxTokensPerSecond: this.options.maxTokensPerSecond ?? 6.5,
    };
    let loaded: LoadedModel;
    if (isStreamingModelArch(this.modelArch)) {
      let model: MoonshineStreamingModel;
      try {
        model = await MoonshineStreamingModel.load(files, loadOptions);
      } catch (e) {
        rethrowIfCancelled(e);
        throw new Error(
          `Failed to load Moonshine streaming models from ${this.modelPath}: ${errorMessage(e)}`,
        );
      }
      loaded = { kind: "streaming", model, state: model.createState() };
    } else {
      for (const [what, name] of [
        ["encoder model", "encoder_model.ort"],
        ["decoder model", "decoder_model_merged.ort"],
      ] as const) {
        if (!(await files.exists(name))) {
          throw new Error(`Required ${what} file does not exist at path '${files.pathOf(name)}'`);
        }
      }
      try {
        loaded = {
          kind: "non-streaming",
          model: await MoonshineModel.load(files, this.modelArch, loadOptions),
        };
      } catch (e) {
        rethrowIfCancelled(e);
        throw new Error(
          `Failed to load Moonshine models from ${this.modelPath}: ${errorMessage(e)}`,
        );
      }
    }
    await this.#sileroVad();
    return loaded;
  }

  /**
   * Transcribe audio data without streaming.
   *
   * The audio is split into speech segments with Silero VAD (at 16 kHz) and
   * each segment is transcribed; silence yields no lines.
   *
   * @param audioData Audio samples (PCM float, -1.0 to 1.0).
   * @param sampleRate Sample rate in Hz (default: 16000); other rates are resampled.
   * @param _flags Flags for transcription (default: 0). Only spelling mode is
   *   defined upstream, and it is not supported.
   * @returns Transcript object containing the transcription lines.
   */
  transcribeWithoutStreaming(
    audioData: Float32Array | ArrayLike<number>,
    sampleRate = 16000,
    _flags = 0,
  ): Promise<Transcript> {
    const audio = audioData instanceof Float32Array ? audioData : Float32Array.from(audioData);
    // One batch at a time, like the C++ batch-stream mutex: the VAD keeps state.
    const run = this.#tail.then(() => this.#transcribe(audio, sampleRate));
    this.#tail = run.catch(() => {});
    return run;
  }

  async #transcribe(audio: Float32Array, sampleRate: number): Promise<Transcript> {
    const loaded = await this.#load();
    this.#vad.start();
    await this.#vad.processAudio(audio, sampleRate);
    this.#vad.stop();
    const returnAudioData = this.options.returnAudioData ?? true;

    const lines: TranscriptLine[] = [];
    for (const segment of this.#vad.segments) {
      if (!segment.justUpdated) continue;
      const started = performance.now();
      const bytes =
        loaded.kind === "streaming"
          ? await loaded.model.transcribeSegment(loaded.state, segment.audioData, true)
          : await loaded.model.transcribe(segment.audioData);
      const text = sanitizeText(bytes);
      lines.push({
        text,
        startTime: segment.startTime,
        duration: Math.fround(segment.endTime - segment.startTime),
        lineId: this.#nextLineId,
        // The VAD is stopped, so every line is complete.
        isComplete: true,
        isUpdated: segment.justUpdated,
        isNew: true,
        hasTextChanged: true,
        audioData: returnAudioData ? segment.audioData : null,
        lastTranscriptionLatencyMs: Math.trunc(performance.now() - started),
      });
      this.#nextLineId = BigInt.asUintN(64, this.#nextLineId + 1n);
    }
    return { lines };
  }

  /** Free the transcriber resources (its own sessions, when not shared). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const loading = this.#loading;
    this.#loading = null;
    if (loading === null || (this.options.shareSessions ?? true)) return;
    try {
      const loaded = await loading;
      const m = loaded.model;
      const sessions =
        loaded.kind === "streaming"
          ? [
              loaded.model.frontend,
              loaded.model.encoder,
              loaded.model.adapter,
              loaded.model.crossKv,
              loaded.model.decoderKv,
            ]
          : [(m as MoonshineModel).encoder, (m as MoonshineModel).decoder];
      for (const session of sessions) await session.dispose();
    } catch {
      // Nothing was loaded, so nothing to release.
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
