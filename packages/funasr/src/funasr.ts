// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A small SenseVoice runtime with the part of the `funasr` Python API that
 * Pipecat's FunASR service uses: `AutoModel({ model, device, disableUpdate })`,
 * `generate({ input, cache, language, useItn })` and
 * `richTranscriptionPostprocess(text)`.
 *
 * FunASR runs SenseVoiceSmall with PyTorch. This runs the same weights
 * through `@pipedog/onnx` (onnxruntime-node or onnxruntime-web), using
 * sherpa-onnx's ONNX export of `iic/SenseVoiceSmall`
 * (`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` on Hugging
 * Face: `model.int8.onnx`, 239 MB, or `model.onnx`, 938 MB, plus `tokens.txt`).
 * The front end (Kaldi fbank, LFR, CMVN) is FunASR's `WavFrontend` (see
 * `frontend.ts`), with its parameters read from the model's metadata, and the
 * decoding is FunASR's: CTC greedy search (argmax, collapse repeats, drop the
 * blank) and SentencePiece detokenization, so `generate()` returns the same raw
 * text with `<|lang|><|emotion|><|event|><|itn|>` tags that FunASR does.
 *
 * Files are downloaded once to `~/.cache/pipedog/funasr` (see
 * `modelCacheDir`). Pass a directory or explicit paths to use local files.
 *
 * @example
 * ```ts
 * import { AutoModel, richTranscriptionPostprocess } from "@pipedog/funasr/funasr";
 * const model = new AutoModel({ model: "iic/SenseVoiceSmall" });
 * const [result] = await model.generate({ input: samples, language: "auto", useItn: true });
 * console.log(richTranscriptionPostprocess(result.text));
 * ```
 */

import {
  createOnnxBackend,
  downloadModelFile,
  float32Tensor,
  int32Tensor,
  loadModelBytes,
  modelCacheDir,
  modelUrl,
  type OnnxBackend,
  type OnnxModelSource,
  type OnnxSession,
  sharedSession,
} from "@pipedog/onnx";
import { senseVoiceFeatures } from "./frontend.ts";
import { readOnnxMetadata } from "./onnx_metadata.ts";

export { richTranscriptionPostprocess } from "./postprocess_utils.ts";

/** The Hugging Face repository with sherpa-onnx's SenseVoiceSmall export. */
export const SENSE_VOICE_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
/** The pinned revision of `SENSE_VOICE_REPO`. */
export const SENSE_VOICE_REVISION = "2365baeacb507f821a0c8120fcee3d484dba7a07";

/** Model names that resolve to the downloaded SenseVoiceSmall export. */
export const SENSE_VOICE_MODEL_IDS: readonly string[] = [
  "iic/SenseVoiceSmall",
  "FunAudioLLM/SenseVoiceSmall",
  SENSE_VOICE_REPO,
];

/** The download URL of one file of the SenseVoiceSmall export. */
export function senseVoiceFileUrl(file: string): string {
  return `https://huggingface.co/${SENSE_VOICE_REPO}/resolve/${SENSE_VOICE_REVISION}/${file}`;
}

/** SenseVoice's language ids (`lid_dict`), used when the model has no metadata. */
export const SENSE_VOICE_LANGUAGE_IDS: Readonly<Record<string, number>> = {
  auto: 0,
  zh: 3,
  en: 4,
  yue: 7,
  ja: 11,
  ko: 12,
  nospeech: 13,
};

/** SenseVoice's text-normalization ids (`textnorm_dict`). */
export const SENSE_VOICE_TEXTNORM_IDS: Readonly<Record<string, number>> = {
  withitn: 14,
  woitn: 15,
};

const SPACE_SYMBOL = "▁";
const BLANK_ID = 0;

export interface AutoModelOptions {
  /**
   * `"iic/SenseVoiceSmall"` (also `"FunAudioLLM/SenseVoiceSmall"`) downloads
   * sherpa-onnx's ONNX export of it. Otherwise a directory holding
   * `model.int8.onnx` or `model.onnx` and `tokens.txt`, or the path of a
   * SenseVoice `.onnx` file with `tokens.txt` next to it.
   */
  model: string;
  /**
   * `"cpu"` or `"cuda"`. Inference always runs on the CPU (onnxruntime's
   * default execution provider); `"cuda"` is accepted for compatibility.
   */
  device?: string;
  /** FunASR's "don't check for a newer funasr" flag. Accepted and ignored. */
  disableUpdate?: boolean;
  /** Use the int8-quantized model (default `true`; 239 MB instead of 938 MB). */
  quantized?: boolean;
  /** The ONNX model to load (bytes, path or URL), instead of resolving `model`. */
  modelFile?: OnnxModelSource;
  /** `tokens.txt` (path, URL or contents as bytes) or the token list, instead of resolving `model`. */
  tokens?: string | URL | Uint8Array | readonly string[];
  /** Where downloaded files go (default: `modelCacheDir("funasr")`). */
  cacheDir?: string;
  /** `fetch` for downloads (default: the global `fetch`). */
  fetch?: typeof fetch;
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
  /** Share one inference session per model across instances (default `true`). */
  shareSession?: boolean;
}

/** Arguments of `AutoModel.generate()`. */
export interface GenerateOptions {
  /** Mono 16 kHz samples in [-1, 1]. */
  input: Float32Array;
  /** Streaming cache. SenseVoice is not streaming; accepted and ignored. */
  cache?: Record<string, unknown>;
  /** `"auto"`, `"zh"`, `"en"`, `"yue"`, `"ja"`, `"ko"` or `"nospeech"`; anything else means auto. */
  language?: string;
  /** Inverse text normalization (punctuation, digits). Default `false`, as in FunASR. */
  useItn?: boolean;
  /** `"withitn"` or `"woitn"`; overrides `useItn`. */
  textNorm?: string;
}

/** One result of `AutoModel.generate()`. */
export interface GenerateResult {
  key: string;
  /** Raw SenseVoice text, with its `<|...|>` tags. */
  text: string;
}

interface LoadedModel {
  session: OnnxSession;
  tokens: string[];
  lfrM: number;
  lfrN: number;
  negMean: Float32Array;
  invStddev: Float32Array;
  languageIds: Record<string, number>;
  textnormIds: Record<string, number>;
}

// Held in variables so bundlers leave the imports alone; only used where there
// is a filesystem (Bun, Node, Deno).
const NODE_FS = "node:fs/promises";
const NODE_PATH = "node:path";

interface NodeFs {
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readFile(path: string): Promise<Uint8Array>;
}
interface NodePath {
  join(...parts: string[]): string;
  dirname(path: string): string;
}

async function exists(fs: NodeFs, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

function parseFloats(value: string | undefined, name: string): Float32Array {
  if (!value) throw new Error(`SenseVoice model metadata has no "${name}"`);
  return Float32Array.from(value.split(",").map(Number));
}

/** Parse sherpa-onnx's `tokens.txt` (`<piece> <id>` per line). */
export function parseTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) continue;
    const space = trimmed.lastIndexOf(" ");
    if (space < 0) {
      // A piece that is itself whitespace leaves only the id on the line.
      tokens[Number(trimmed)] = " ";
      continue;
    }
    tokens[Number(trimmed.slice(space + 1))] = trimmed.slice(0, space);
  }
  return tokens;
}

/**
 * SentencePiece `DecodeIds` for SenseVoice's vocabulary: `<s>`/`</s>` are
 * invisible, `▁` becomes a space, and the leading `▁` is dropped while the
 * text is still empty.
 */
export function decodePieces(ids: readonly number[], tokens: readonly string[]): string {
  let text = "";
  for (const id of ids) {
    let piece = tokens[id];
    if (piece === undefined || piece === "<s>" || piece === "</s>") continue;
    if (piece === "<unk>") {
      text += " ⁇ ";
      continue;
    }
    if (text.length === 0 && piece.startsWith(SPACE_SYMBOL))
      piece = piece.slice(SPACE_SYMBOL.length);
    text += piece.replaceAll(SPACE_SYMBOL, " ");
  }
  return text;
}

/** CTC greedy search over `[frames, vocab]` logits: argmax, collapse repeats, drop the blank. */
export function ctcGreedySearch(
  logits: Float32Array,
  frames: number,
  vocab: number,
  blankId = BLANK_ID,
): number[] {
  const out: number[] = [];
  let prev = -1;
  for (let t = 0; t < frames; t++) {
    const base = t * vocab;
    let best = 0;
    let bestValue = logits[base]!;
    for (let v = 1; v < vocab; v++) {
      const value = logits[base + v]!;
      if (value > bestValue) {
        bestValue = value;
        best = v;
      }
    }
    if (best !== prev && best !== blankId) out.push(best);
    prev = best;
  }
  return out;
}

/**
 * A SenseVoice model, loaded on first use.
 *
 * The constructor only records the options (FunASR's loads the model
 * synchronously); files are resolved, downloaded and loaded by `load()`, which
 * `generate()` calls.
 */
export class AutoModel {
  readonly options: AutoModelOptions;
  #loading: Promise<LoadedModel> | null = null;

  constructor(options: AutoModelOptions) {
    if (!options.model && options.modelFile === undefined) {
      throw new Error("AutoModel: `model` must be specified");
    }
    this.options = options;
  }

  /** Resolve, download if needed, and load the model. Safe to call repeatedly. */
  load(): Promise<void> {
    return this.#load().then(() => undefined);
  }

  #load(): Promise<LoadedModel> {
    if (!this.#loading) {
      this.#loading = this.#doLoad();
      // A failed load is retried on the next call.
      this.#loading.catch(() => {
        this.#loading = null;
      });
    }
    return this.#loading;
  }

  async #resolveFiles(): Promise<{ model: OnnxModelSource; tokens: AutoModelOptions["tokens"] }> {
    const { options } = this;
    const quantized = options.quantized ?? true;
    const modelName = quantized ? "model.int8.onnx" : "model.onnx";
    if (options.modelFile !== undefined && options.tokens !== undefined) {
      return { model: options.modelFile, tokens: options.tokens };
    }
    const fs = (await import(NODE_FS)) as NodeFs;
    const path = (await import(NODE_PATH)) as NodePath;

    if (options.modelFile !== undefined) {
      if (typeof options.modelFile === "string" && modelUrl(options.modelFile) === null) {
        return {
          model: options.modelFile,
          tokens: path.join(path.dirname(options.modelFile), "tokens.txt"),
        };
      }
      throw new Error("AutoModel: pass `tokens` along with a `modelFile` given as bytes or a URL");
    }

    const name = options.model;
    if (SENSE_VOICE_MODEL_IDS.includes(name)) {
      const dir = path.join(
        options.cacheDir ?? (await modelCacheDir("funasr")),
        SENSE_VOICE_REPO.split("/")[1]!,
      );
      const download = { fetch: options.fetch };
      const modelPath = await downloadModelFile(
        senseVoiceFileUrl(modelName),
        path.join(dir, modelName),
        download,
      );
      const tokensPath =
        options.tokens ??
        (await downloadModelFile(
          senseVoiceFileUrl("tokens.txt"),
          path.join(dir, "tokens.txt"),
          download,
        ));
      return { model: modelPath, tokens: tokensPath };
    }

    let stat: { isDirectory(): boolean; isFile(): boolean } | null = null;
    try {
      stat = await fs.stat(name);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) {
      const candidates = quantized
        ? ["model.int8.onnx", "model.onnx"]
        : ["model.onnx", "model.int8.onnx"];
      for (const candidate of candidates) {
        const file = path.join(name, candidate);
        if (await exists(fs, file)) {
          return { model: file, tokens: options.tokens ?? path.join(name, "tokens.txt") };
        }
      }
      throw new Error(
        `FunASR model directory ${name} has no model.int8.onnx or model.onnx. ` +
          "pipedog runs SenseVoice ONNX exports (sherpa-onnx layout), not PyTorch checkpoints.",
      );
    }
    if (stat?.isFile() && name.endsWith(".onnx")) {
      return { model: name, tokens: options.tokens ?? path.join(path.dirname(name), "tokens.txt") };
    }
    throw new Error(
      `Unsupported FunASR model "${name}": use "iic/SenseVoiceSmall", a directory with a SenseVoice ` +
        "ONNX export (model.int8.onnx or model.onnx, and tokens.txt), or the path of the .onnx file.",
    );
  }

  async #doLoad(): Promise<LoadedModel> {
    const { options } = this;
    let { model, tokens } = await this.#resolveFiles();

    // Remote models are fetched once so their metadata can be read.
    if (!(model instanceof Uint8Array || model instanceof ArrayBuffer)) {
      const url = modelUrl(model);
      if (url && url.protocol !== "file:") model = await loadModelBytes(url);
    }
    const metadata = await readOnnxMetadata(model);

    let tokenList: string[];
    if (Array.isArray(tokens)) {
      tokenList = [...tokens];
    } else if (tokens instanceof Uint8Array) {
      tokenList = parseTokens(new TextDecoder().decode(tokens));
    } else if (tokens !== undefined) {
      const source = tokens as string | URL;
      const url = modelUrl(source);
      let bytes: Uint8Array;
      if (url && url.protocol !== "file:") {
        const doFetch = options.fetch ?? fetch;
        const res = await doFetch(url);
        if (!res.ok) throw new Error(`Failed to fetch ${url.href}: HTTP ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        bytes = await loadModelBytes(source);
      }
      tokenList = parseTokens(new TextDecoder().decode(bytes));
    } else {
      throw new Error("AutoModel: no tokens.txt for the SenseVoice model");
    }

    const id = (key: string, fallback: number) =>
      metadata[key] !== undefined ? Number(metadata[key]) : fallback;
    const languageIds: Record<string, number> = {};
    for (const [lang, fallback] of Object.entries(SENSE_VOICE_LANGUAGE_IDS)) {
      languageIds[lang] = id(`lang_${lang}`, fallback);
    }
    const textnormIds = {
      withitn: id("with_itn", SENSE_VOICE_TEXTNORM_IDS.withitn!),
      woitn: id("without_itn", SENSE_VOICE_TEXTNORM_IDS.woitn!),
    };

    const backend = await (options.backend ?? createOnnxBackend());
    const sessionOptions = {};
    const session =
      options.shareSession === false
        ? await backend.createSession(model, sessionOptions)
        : await sharedSession(backend, model, sessionOptions);

    return {
      session,
      tokens: tokenList,
      lfrM: id("lfr_window_size", 7),
      lfrN: id("lfr_window_shift", 6),
      negMean: parseFloats(metadata.neg_mean, "neg_mean"),
      invStddev: parseFloats(metadata.inv_stddev, "inv_stddev"),
      languageIds,
      textnormIds,
    };
  }

  /**
   * Transcribe one clip. Returns `[{ key, text }]` with SenseVoice's raw text,
   * e.g. `<|en|><|NEUTRAL|><|Speech|><|withitn|>Hello.`; pass it to
   * `richTranscriptionPostprocess()` for display text.
   */
  async generate(options: GenerateOptions): Promise<GenerateResult[]> {
    const m = await this.#load();
    const key = "wav_file_tmp_name";
    const feats = senseVoiceFeatures(options.input, {
      lfrM: m.lfrM,
      lfrN: m.lfrN,
      negMean: m.negMean,
      invStddev: m.invStddev,
    });
    if (feats.rows === 0) return [{ key, text: "" }];

    const language = options.language ?? "auto";
    const languageId = m.languageIds[language] ?? 0;
    const textnorm = options.textNorm ?? (options.useItn ? "withitn" : "woitn");
    const textnormId = m.textnormIds[textnorm];
    if (textnormId === undefined) throw new Error(`Unknown SenseVoice text_norm "${textnorm}"`);

    const [xName, lengthName, languageName, textnormName] = m.session.inputNames as string[];
    const outputs = await m.session.run({
      [xName ?? "x"]: float32Tensor(feats.data, [1, feats.rows, feats.cols]),
      [lengthName ?? "x_length"]: int32Tensor(Int32Array.of(feats.rows), [1]),
      [languageName ?? "language"]: int32Tensor(Int32Array.of(languageId), [1]),
      [textnormName ?? "text_norm"]: int32Tensor(Int32Array.of(textnormId), [1]),
    });
    const logits = outputs[m.session.outputNames[0]!]!;
    const [, frames = 0, vocab = 0] = logits.dims;
    const ids = ctcGreedySearch(logits.data as Float32Array, frames, vocab);
    return [{ key, text: decodePieces(ids, m.tokens) }];
  }
}
