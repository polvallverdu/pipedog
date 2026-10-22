// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Pocket TTS inference in JavaScript: the `pocket_tts.TTSModel` surface that
 * pipecat's `PocketTTSService` uses, running Kyutai's Pocket TTS on ONNX
 * Runtime through `@pipedog/onnx`.
 *
 * ## What runs
 *
 * Pocket TTS is a text conditioner (SentencePiece tokens → embeddings), a
 * causal transformer "flow LM" that emits one 32-dim latent per 80 ms frame
 * through a one-step LSD flow-matching head, and the Mimi decoder that turns
 * each latent into 1920 samples at 24 kHz. A voice is a prefix of the flow
 * LM's KV cache.
 *
 * - **Graphs**: the ONNX export of Kyutai's weights in
 *   [`KevinAHM/pocket-tts-onnx`](https://huggingface.co/KevinAHM/pocket-tts-onnx)
 *   (CC-BY-4.0, ungated), pinned to one revision: `text_conditioner`,
 *   `flow_lm_main` (transformer + KV cache in/out), `flow_lm_flow` (the flow
 *   net, run by our LSD loop so `temp` / `lsd_decode_steps` / `noise_clamp`
 *   work as upstream) and `mimi_decoder` (streaming, state in/out). Its
 *   `bundle.json` describes every state tensor. For the six languages pipecat
 *   maps, the fp32 graphs were checked against pocket-tts 2.1.0 (PyTorch, the
 *   weights pipecat loads): every module agrees to ~1e-6 relative error.
 * - **Tokenizer and voices**: Kyutai's own files from the ungated
 *   `kyutai/pocket-tts-without-voice-cloning` repo, at the revisions
 *   pocket-tts 2.1.0 pins (`tokenizer.model`; predefined voices are
 *   precomputed KV-cache states, `languages/<language>/embeddings/<voice>.safetensors`).
 *   The tokenizer is read by our SentencePiece implementation (`./sentencepiece.ts`).
 *
 * ## Differences from pocket-tts
 *
 * - The sampling noise comes from `Math.random` (or `random`), not torch's
 *   generator, so with `temp > 0` audio differs sample by sample from
 *   PyTorch's, as two seeds would. With `temp = 0` it matches.
 * - `quantize: true` loads `flow_lm_main_int8.onnx`, ONNX Runtime's dynamic
 *   int8 quantization of the flow LM transformer — the same layers
 *   pocket-tts quantizes with torchao (attention and FFN); the flow net and
 *   Mimi stay fp32 in both. The int8 kernels differ from torchao's, so the
 *   output is not bit-identical to upstream's quantized model.
 * - The exported flow LM has a fixed KV cache of 1000 positions (voice prompt
 *   + text tokens + generated frames). pocket-tts grows its cache instead; here
 *   a chunk whose generation budget would overflow it is cut short with a
 *   warning (pocket-tts' 50-token chunks and predefined voices stay far below).
 * - Voice cloning from audio needs a Mimi encoder exported from Kyutai's gated
 *   voice-cloning weights; it is never downloaded for you (see
 *   `LoadModelOptions.voiceCloningModel`). pocket-tts likewise refuses to
 *   clone without access to the gated `kyutai/pocket-tts` repo.
 * - Audio prompts are read from WAV only (pocket-tts reads any format with
 *   soundfile/av); decode other formats yourself and pass the samples.
 * - Generation and Mimi decoding overlap (the next flow-LM step runs while the
 *   current frame decodes) instead of running in two threads.
 */

import { createFileResampler } from "@pipedog/core/audio/utils";
import { logger } from "@pipedog/core/utils/logger";
import {
  createOnnxBackend,
  downloadModelFile,
  fileExists,
  float32Tensor,
  int64Tensor,
  loadModelBytes,
  modelCacheDir,
  type OnnxBackend,
  type OnnxModelSource,
  type OnnxSession,
  type OnnxSessionOptions,
  type OnnxTensor,
  type OnnxTensorData,
  sharedSession,
} from "@pipedog/onnx";
import { SentencePieceProcessor } from "./sentencepiece.ts";
import { decodeWav, type FileTensor, readNpy, readSafetensors } from "./tensor_files.ts";

// ---------------------------------------------------------------------------
// Defaults (pocket_tts/default_parameters.py, v2.1.0)

export const DEFAULT_LANGUAGE = "english";
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_LSD_DECODE_STEPS = 1;
export const DEFAULT_NOISE_CLAMP: number | null = null;
export const DEFAULT_EOS_THRESHOLD = -4.0;
export const MAX_TOKEN_PER_CHUNK = 50;

const TOKENS_PER_SECOND_ESTIMATE = 3.0;
const GEN_SECONDS_PADDING = 2.0;

/** The predefined voices pocket-tts ships as precomputed states for every language. */
export const PREDEFINED_VOICES = [
  "cosette",
  "marius",
  "javert",
  "alba",
  "jean",
  "anna",
  "vera",
  "fantine",
  "charles",
  "paul",
  "eponine",
  "azelma",
  "george",
  "mary",
  "jane",
  "michael",
  "eve",
  "bill_boerst",
  "peter_yearsley",
  "stuart_bell",
  "caro_davy",
  "giovanni",
  "lola",
  "juergen",
  "rafael",
  "estelle",
] as const;

/** Hugging Face repo and revision of the ONNX graphs. */
export const POCKET_TTS_ONNX_REPO = "KevinAHM/pocket-tts-onnx";
export const POCKET_TTS_ONNX_REVISION = "58a6d00cf13d239b6748cb0769f35c580a8f606c";
/** Kyutai's ungated repo (tokenizers and predefined voice states), and the revisions pocket-tts 2.1.0 pins. */
export const KYUTAI_POCKET_TTS_REPO = "kyutai/pocket-tts-without-voice-cloning";
export const KYUTAI_TOKENIZER_REVISION = "d29db7978e464fb90cb3359ee0c69a273b9142cc";
export const KYUTAI_VOICES_REVISION = "e041936c75475d350b405bc870bcf7c22da4e9e6";

/**
 * The pocket-tts languages (model configs) available, and the ONNX bundle of each.
 *
 * The first six are the ones pipecat maps languages to; their fp32 graphs were
 * verified against pocket-tts. The other `_24l` models come from the same
 * export but were not checked numerically.
 */
export const LANGUAGE_BUNDLES: Readonly<Record<string, string>> = {
  english: "english_2026-04",
  german: "german",
  spanish: "spanish",
  italian: "italian",
  portuguese: "portuguese",
  french_24l: "french_24l",
  german_24l: "german_24l",
  italian_24l: "italian_24l",
  portuguese_24l: "portuguese_24l",
  spanish_24l: "spanish_24l",
};

const HF_BASE_URL = "https://huggingface.co";

// ---------------------------------------------------------------------------
// Text preparation (pocket_tts/models/tts_model.py)

function codePoints(text: string): string[] {
  return Array.from(text);
}

/** Python's `str.split()` word count. */
function countWords(text: string): number {
  return text.split(/\s+/u).filter((w) => w.length > 0).length;
}

/**
 * Normalize a text prompt the way the model was trained on: one line, a
 * leading capital, final punctuation, and optional padding for short inputs.
 *
 * @returns The prepared text and a guess of how many frames to generate after
 *   end-of-speech is detected (3 for up to four words, else 1).
 */
export function prepareTextPrompt(
  text: string,
  padWithSpacesForShortInputs: boolean,
  removeSemicolons: boolean,
): [string, number] {
  let t = text.trim();
  if (t === "") throw new Error("Text prompt cannot be empty");
  t = t.replaceAll("\n", " ").replaceAll("\r", " ").replaceAll("  ", " ");
  if (removeSemicolons) t = t.replaceAll(";", ",");
  const numberOfWords = countWords(t);
  const framesAfterEosGuess = numberOfWords <= 4 ? 3 : 1;

  // Make sure it starts with an uppercase letter
  const chars = codePoints(t);
  if (!/^\p{Uppercase}$/u.test(chars[0]!)) {
    t = chars[0]!.toUpperCase() + chars.slice(1).join("");
  }

  // Let's make sure it ends with some kind of punctuation
  // If it ends with a letter or digit, we add a period.
  const last = codePoints(t).at(-1)!;
  if (/^[\p{L}\p{N}]$/u.test(last)) t = `${t}.`;

  // The model does not perform well when there are very few tokens, so
  // we can add empty spaces at the beginning to increase the token count.
  if (padWithSpacesForShortInputs && countWords(t) < 5) t = " ".repeat(8) + t;

  return [t, framesAfterEosGuess];
}

/**
 * Token indices where text should be split based on boundary tokens: the first
 * element is 0, the last is `tokens.length`, and each consecutive pair is one segment.
 */
export function findBoundaryIndices(
  tokens: readonly number[],
  boundaryTokens: readonly number[],
): number[] {
  const boundaries = new Set(boundaryTokens);
  const indices = [0];
  let previousWasBoundary = false;
  tokens.forEach((token, idx) => {
    if (boundaries.has(token)) {
      previousWasBoundary = true;
    } else {
      if (previousWasBoundary) indices.push(idx);
      previousWasBoundary = false;
    }
  });
  indices.push(tokens.length);
  return indices;
}

/** The tokenizer surface the text chunker needs. */
export interface TextTokenizer {
  encode(text: string): number[];
  decode(ids: readonly number[]): string;
}

function segmentsFromBoundaries(
  tokens: readonly number[],
  boundaryIndices: readonly number[],
  tokenizer: TextTokenizer,
): [number, string][] {
  const segments: [number, string][] = [];
  for (let i = 0; i < boundaryIndices.length - 1; i++) {
    const start = boundaryIndices[i]!;
    const end = boundaryIndices[i + 1]!;
    segments.push([end - start, tokenizer.decode(tokens.slice(start, end))]);
  }
  return segments;
}

/**
 * Split text into chunks of at most `maxTokens` tokens at sentence ends,
 * falling back to commas, semicolons and colons inside long sentences.
 */
export function splitIntoBestSentences(
  tokenizer: TextTokenizer,
  textToGenerate: string,
  maxTokens: number,
  padWithSpacesForShortInputs: boolean,
  removeSemicolons: boolean,
): string[] {
  let [text] = prepareTextPrompt(textToGenerate, padWithSpacesForShortInputs, removeSemicolons);
  text = text.trim();
  const listOfTokens = tokenizer.encode(text);

  const endOfSentenceTokens = tokenizer.encode(".!...?").slice(1);
  const sentenceBoundaries = findBoundaryIndices(listOfTokens, endOfSentenceTokens);
  const nbTokensAndSentences = segmentsFromBoundaries(listOfTokens, sentenceBoundaries, tokenizer);

  // Sub-split oversized sentences on commas, semicolons, and colons to prevent skipped words
  const fallbackTokens = tokenizer.encode(",;:").slice(1);
  const refinedSegments: [number, string][] = [];
  for (const [nbTokens, sentence] of nbTokensAndSentences) {
    if (nbTokens <= maxTokens) {
      refinedSegments.push([nbTokens, sentence]);
    } else {
      const subTokens = tokenizer.encode(sentence.trim());
      const subBoundaries = findBoundaryIndices(subTokens, fallbackTokens);
      const subSegments = segmentsFromBoundaries(subTokens, subBoundaries, tokenizer);
      if (subSegments.length > 1) refinedSegments.push(...subSegments);
      else refinedSegments.push([nbTokens, sentence]);
    }
  }

  const chunks: string[] = [];
  let currentChunk = "";
  let currentNbOfTokensInChunk = 0;
  for (const [nbTokens, sentence] of refinedSegments) {
    if (currentChunk === "") {
      currentChunk = sentence;
      currentNbOfTokensInChunk = nbTokens;
      continue;
    }
    if (currentNbOfTokensInChunk + nbTokens > maxTokens) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
      currentNbOfTokensInChunk = nbTokens;
    } else {
      currentChunk += ` ${sentence}`;
      currentNbOfTokensInChunk += nbTokens;
    }
  }
  if (currentChunk !== "") chunks.push(currentChunk.trim());

  for (const chunk of chunks) {
    const n = tokenizer.encode(chunk.trim()).length;
    if (n > maxTokens) {
      logger.warning(
        `Chunk has ${n} tokens (max ${maxTokens}), generation may skip words: '${chunk.slice(0, 50)}...'`,
      );
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Bundle metadata and model state

/** One state tensor of an exported graph (`bundle.json`). */
export interface StateManifestEntry {
  index: number;
  input_name: string;
  output_name: string;
  module: string;
  key: string;
  shape: number[];
  dtype: "float32" | "int64" | "bool";
  fill: "nan" | "zeros" | "ones" | "empty";
}

/** The `bundle.json` of an ONNX bundle (the fields used here). */
export interface PocketTTSBundleMetadata {
  sample_rate: number;
  frame_rate: number;
  samples_per_frame: number;
  latent_dim: number;
  conditioning_dim: number;
  insert_bos_before_voice: boolean;
  pad_with_spaces_for_short_inputs?: boolean;
  remove_semicolons?: boolean;
  model_recommended_frames_after_eos?: number | null;
  flow_lm_state_manifest: StateManifestEntry[];
  mimi_state_manifest: StateManifestEntry[];
}

function newStateTensor(entry: StateManifestEntry): OnnxTensor {
  const count = entry.shape.reduce((a, b) => a * b, 1);
  if (entry.dtype === "int64") {
    // Nothing is NaN- or one-filled among the integer states.
    return int64Tensor(new BigInt64Array(count), entry.shape);
  }
  if (entry.dtype === "bool") {
    return {
      type: "bool",
      data: new Uint8Array(count).fill(entry.fill === "ones" ? 1 : 0),
      dims: entry.shape,
    };
  }
  const data = new Float32Array(count);
  if (entry.fill === "nan") data.fill(Number.NaN);
  else if (entry.fill === "ones") data.fill(1);
  return float32Tensor(data, entry.shape);
}

function initState(manifest: readonly StateManifestEntry[]): Record<string, OnnxTensor> {
  const state: Record<string, OnnxTensor> = {};
  for (const entry of manifest) state[entry.input_name] = newStateTensor(entry);
  return state;
}

function cloneTensor(t: OnnxTensor): OnnxTensor {
  return { type: t.type, data: t.data.slice() as OnnxTensorData, dims: [...t.dims] };
}

/**
 * The flow LM's streaming state (its KV cache and position), as the ONNX
 * graph takes it: tensors by input name.
 *
 * pocket-tts' model state is a `dict[module][key]` of torch tensors; this is
 * the same state in the exported graph's layout.
 */
export class ModelState {
  tensors: Record<string, OnnxTensor>;

  constructor(tensors: Record<string, OnnxTensor>) {
    this.tensors = tensors;
  }

  /** A deep copy (pocket-tts' `copy.deepcopy(model_state)`). */
  clone(): ModelState {
    const tensors: Record<string, OnnxTensor> = {};
    for (const [name, t] of Object.entries(this.tensors)) tensors[name] = cloneTensor(t);
    return new ModelState(tensors);
  }
}

// ---------------------------------------------------------------------------
// Files

/** The ONNX sessions a `TTSModel` runs. */
export interface PocketTTSSessions {
  textConditioner: OnnxSession;
  flowLmMain: OnnxSession;
  flowLmFlow: OnnxSession;
  mimiDecoder: OnnxSession;
  /** The Mimi encoder with the speaker projection, for voice cloning (optional). */
  mimiEncoder?: OnnxSession | null;
}

/** Everything needed to build a `TTSModel` from already loaded parts. */
export interface TTSModelInit {
  /** pocket-tts language (model config) name, e.g. `english`. */
  language: string;
  metadata: PocketTTSBundleMetadata;
  tokenizer: TextTokenizer;
  sessions: PocketTTSSessions;
  temp?: number;
  lsdDecodeSteps?: number;
  noiseClamp?: number | null;
  eosThreshold?: number;
  quantize?: boolean;
  /** `flow_lm.bos_before_voice` ([1, 1, conditioning_dim]); needed for voice cloning. */
  bosBeforeVoice?: Float32Array | null;
  /** Fetch the `.safetensors` state of a predefined voice. */
  loadPredefinedVoice?: (name: string) => Promise<Uint8Array>;
  /** Read a voice prompt or state from a path or URL (`hf://`, `https://`, local). */
  loadFile?: (pathOrUrl: string) => Promise<Uint8Array>;
  /** Uniform random numbers in [0, 1) for the sampling noise. Default: `Math.random`. */
  random?: () => number;
}

/** Options of `TTSModel.loadModel()`. */
export interface LoadModelOptions {
  /** pocket-tts language (model config) name. Default `"english"`. See `LANGUAGE_BUNDLES`. */
  language?: string | null;
  /** Sampling temperature. Default 0.7. */
  temp?: number;
  /** Number of LSD flow steps per frame. Default 1. */
  lsdDecodeSteps?: number;
  /** Bound of the (truncated normal) sampling noise; `null` for none. Default `null`. */
  noiseClamp?: number | null;
  /** End-of-speech logit threshold. Default -4.0. */
  eosThreshold?: number;
  /** Use the int8-quantized flow LM transformer. Default false. */
  quantize?: boolean;
  /**
   * ONNX backend. Default: onnxruntime-node (`createOnnxBackend({ prefer: "native" })`).
   * onnxruntime-web 1.30 can't run these graphs: it fails reading their empty
   * (zero-length) state outputs.
   */
  backend?: OnnxBackend;
  /** Session options. Default `{ intraOpNumThreads: 4, interOpNumThreads: 1 }`. */
  sessionOptions?: OnnxSessionOptions;
  /** Share sessions per process (`sharedSession`); the graphs are stateless. Default true. */
  shareSessions?: boolean;
  /**
   * A directory holding the bundle files (`bundle.json`, `text_conditioner.onnx`,
   * `flow_lm_main.onnx` or `flow_lm_main_int8.onnx`, `flow_lm_flow.onnx`,
   * `mimi_decoder.onnx`, `tokenizer.model`, and optionally `bos_before_voice.npy`
   * and `embeddings/<voice>.safetensors`). Files found there are not downloaded.
   */
  modelDir?: string | null;
  /** Download cache. Default `modelCacheDir("pocket-tts")`. */
  cacheDir?: string | null;
  /** `fetch` for downloads. */
  fetch?: typeof fetch;
  /** Hugging Face token sent to huggingface.co (for `hf://` files in gated repos). Default `$HF_TOKEN`. */
  hfToken?: string | null;
  /**
   * The Mimi encoder for voice cloning: an ONNX graph taking `audio`
   * [1, 1, samples] at 24 kHz and returning the speaker-projected latents
   * [1, frames, 1024], exported from Kyutai's gated `kyutai/pocket-tts`
   * weights (accept their terms first). Not downloaded by default.
   */
  voiceCloningModel?: OnnxModelSource | null;
  /** Uniform random numbers in [0, 1) for the sampling noise. Default `Math.random`. */
  random?: () => number;
}

/** Options of `generateAudioStream()` / `generateAudio()`. */
export interface GenerateAudioOptions {
  /** Maximum tokens per text chunk. Default 50. */
  maxTokens?: number;
  /** Frames to generate after end-of-speech; `null` guesses from the text. */
  framesAfterEos?: number | null;
  /** Generate from a copy of the state, leaving it reusable. Default true. */
  copyState?: boolean;
}

/** A voice prompt given as samples. */
export interface AudioPrompt {
  audio: Float32Array;
  sampleRate: number;
}

const NODE_PATH = "node:path";

interface NodePathModule {
  join(...parts: string[]): string;
}

async function nodePath(): Promise<NodePathModule> {
  return (await import(NODE_PATH)) as NodePathModule;
}

async function readLocalFile(path: string): Promise<Uint8Array> {
  return loadModelBytes(path);
}

function env(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return value ? value : undefined;
}

/** `hf://org/repo/path@revision` → repo, path and revision. */
export function parseHfPath(path: string): { repo: string; file: string; revision: string } {
  const rest = path.slice("hf://".length);
  const parts = rest.split("/");
  const repo = parts.slice(0, 2).join("/");
  let file = parts.slice(2).join("/");
  let revision = "main";
  const at = file.lastIndexOf("@");
  if (at >= 0) {
    revision = file.slice(at + 1);
    file = file.slice(0, at);
  }
  return { repo, file, revision };
}

class FileResolver {
  readonly #cacheDir: Promise<string>;
  readonly #fetch: typeof fetch | undefined;
  readonly #hfToken: string | null;

  constructor(options: LoadModelOptions) {
    this.#cacheDir = options.cacheDir
      ? Promise.resolve(options.cacheDir)
      : modelCacheDir("pocket-tts");
    const base = options.fetch;
    this.#hfToken = options.hfToken === undefined ? (env("HF_TOKEN") ?? null) : options.hfToken;
    this.#fetch = this.#hfToken ? this.#authorizedFetch(base ?? fetch) : base;
  }

  #authorizedFetch(base: typeof fetch): typeof fetch {
    const token = this.#hfToken;
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!token || !url.startsWith(`${HF_BASE_URL}/`)) return base(input, init);
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return base(input, { ...init, headers });
    }) as typeof fetch;
  }

  /** Download `repo/file@revision` into the cache (once) and return its path. */
  async hf(repo: string, file: string, revision: string): Promise<string> {
    const path = await nodePath();
    const dest = path.join(await this.#cacheDir, ...repo.split("/"), revision, ...file.split("/"));
    const url = `${HF_BASE_URL}/${repo}/resolve/${revision}/${file}`;
    return downloadModelFile(url, dest, { fetch: this.#fetch });
  }

  /** A local path for a path or URL (`hf://`, `http(s)://` are downloaded once). */
  async local(pathOrUrl: string): Promise<string> {
    if (pathOrUrl.startsWith("hf://")) {
      const { repo, file, revision } = parseHfPath(pathOrUrl);
      return this.hf(repo, file, revision);
    }
    if (/^https?:\/\//.test(pathOrUrl)) {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pathOrUrl)),
      );
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
      const ext =
        pathOrUrl
          .split(".")
          .at(-1)
          ?.replace(/[^A-Za-z0-9]/g, "") || "bin";
      const path = await nodePath();
      const dest = path.join(await this.#cacheDir, "urls", `${hex}.${ext}`);
      return downloadModelFile(pathOrUrl, dest, { fetch: this.#fetch });
    }
    return pathOrUrl;
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await readLocalFile(path))) as T;
}

function voiceCloningUnsupported(): Error {
  return new Error(
    "Voice cloning from audio is not available: it needs the Mimi encoder exported from Kyutai's " +
      "voice-cloning weights, which are gated (accept the terms at https://huggingface.co/kyutai/pocket-tts). " +
      "Export the encoder to ONNX (input `audio` [1, 1, samples] at 24 kHz, output the speaker-projected " +
      "latents [1, frames, 1024]) and pass it as `voiceCloningModel`. Without it, use one of the predefined " +
      `voices (${PREDEFINED_VOICES.join(", ")}) or a .safetensors voice state exported with ` +
      "`pocket-tts export-voice`.",
  );
}

// ---------------------------------------------------------------------------
// The model

interface FlowStepResult {
  conditioning: OnnxTensor;
  eosLogit: number;
}

/**
 * Kyutai's Pocket TTS: text in, 24 kHz float audio out, streamed per 80 ms frame.
 *
 * Mirrors `pocket_tts.TTSModel` (`load_model`, `sample_rate`,
 * `get_state_for_audio_prompt`, `generate_audio_stream`, `generate_audio`).
 *
 * @example
 * ```ts
 * const model = await TTSModel.loadModel({ language: "english" });
 * const voice = await model.getStateForAudioPrompt("alba");
 * for await (const chunk of model.generateAudioStream(voice, "Hello world.")) {
 *   play(chunk, model.sampleRate); // Float32Array in [-1, 1]
 * }
 * ```
 */
export class TTSModel {
  readonly language: string;
  readonly temp: number;
  readonly lsdDecodeSteps: number;
  readonly noiseClamp: number | null;
  readonly eosThreshold: number;
  readonly quantize: boolean;
  readonly metadata: PocketTTSBundleMetadata;
  readonly tokenizer: TextTokenizer;
  readonly padWithSpacesForShortInputs: boolean;
  readonly removeSemicolons: boolean;
  readonly modelRecommendedFramesAfterEos: number | null;

  readonly #sessions: PocketTTSSessions;
  readonly #bosBeforeVoice: Float32Array | null;
  readonly #loadPredefinedVoice: ((name: string) => Promise<Uint8Array>) | null;
  readonly #loadFile: (pathOrUrl: string) => Promise<Uint8Array>;
  readonly #random: () => number;
  readonly #flowCacheCapacity: number;
  #spareGaussian: number | null = null;

  constructor(init: TTSModelInit) {
    this.language = init.language;
    this.metadata = init.metadata;
    this.tokenizer = init.tokenizer;
    this.temp = init.temp ?? DEFAULT_TEMPERATURE;
    this.lsdDecodeSteps = init.lsdDecodeSteps ?? DEFAULT_LSD_DECODE_STEPS;
    this.noiseClamp = init.noiseClamp ?? DEFAULT_NOISE_CLAMP;
    this.eosThreshold = init.eosThreshold ?? DEFAULT_EOS_THRESHOLD;
    this.quantize = init.quantize ?? false;
    this.padWithSpacesForShortInputs = init.metadata.pad_with_spaces_for_short_inputs ?? false;
    this.removeSemicolons = init.metadata.remove_semicolons ?? false;
    this.modelRecommendedFramesAfterEos = init.metadata.model_recommended_frames_after_eos ?? null;
    this.#sessions = init.sessions;
    this.#bosBeforeVoice = init.bosBeforeVoice ?? null;
    this.#loadPredefinedVoice = init.loadPredefinedVoice ?? null;
    this.#loadFile = init.loadFile ?? readLocalFile;
    this.#random = init.random ?? Math.random;
    if (this.lsdDecodeSteps < 1) throw new Error("lsdDecodeSteps must be at least 1");
    const cache = init.metadata.flow_lm_state_manifest.find((e) => e.key === "cache");
    this.#flowCacheCapacity = cache ? cache.shape[2]! : Number.POSITIVE_INFINITY;
  }

  /**
   * Load a pre-trained model: download (once) and open the ONNX graphs, the
   * tokenizer and the bundle metadata of `language`.
   *
   * pocket-tts' `load_model(language, temp, lsd_decode_steps, noise_clamp,
   * eos_threshold, quantize)`; the `config` argument (a custom YAML model
   * config) has no equivalent here.
   */
  static async loadModel(options: LoadModelOptions = {}): Promise<TTSModel> {
    const language = options.language ?? DEFAULT_LANGUAGE;
    if (language === "french") {
      throw new Error(
        "For technical reasons, only a larger 24-layer model is available for French. Please use the 'french_24l' language instead.",
      );
    }
    const bundle = LANGUAGE_BUNDLES[language];
    if (!bundle) {
      throw new Error(
        `Unknown Pocket TTS language '${language}'. Available: ${Object.keys(LANGUAGE_BUNDLES).join(", ")}`,
      );
    }
    const quantize = options.quantize ?? false;
    // Before any download, so a missing runtime fails fast.
    const backend = options.backend ?? (await createOnnxBackend({ prefer: "native" }));
    const resolver = new FileResolver(options);
    const path = await nodePath();
    const modelDir = options.modelDir ?? null;

    const fromBundle = async (name: string): Promise<string> => {
      if (modelDir) {
        const local = path.join(modelDir, name);
        if (await fileExists(local)) return local;
      }
      return resolver.hf(POCKET_TTS_ONNX_REPO, `onnx/${bundle}/${name}`, POCKET_TTS_ONNX_REVISION);
    };
    const fromKyutai = async (file: string, revision: string, localName: string) => {
      if (modelDir) {
        const local = path.join(modelDir, localName);
        if (await fileExists(local)) return local;
      }
      return resolver.hf(KYUTAI_POCKET_TTS_REPO, file, revision);
    };

    const mainName = quantize ? "flow_lm_main_int8.onnx" : "flow_lm_main.onnx";
    const [metadataPath, tokenizerPath, textConditionerPath, mainPath, flowPath, decoderPath] =
      await Promise.all([
        fromBundle("bundle.json"),
        fromKyutai(
          `languages/${language}/tokenizer.model`,
          KYUTAI_TOKENIZER_REVISION,
          "tokenizer.model",
        ),
        fromBundle("text_conditioner.onnx"),
        fromBundle(mainName),
        fromBundle("flow_lm_flow.onnx"),
        fromBundle("mimi_decoder.onnx"),
      ]);
    const metadata = await readJsonFile<PocketTTSBundleMetadata>(metadataPath);
    const tokenizer = new SentencePieceProcessor(await readLocalFile(tokenizerPath));

    const sessionOptions = options.sessionOptions ?? { intraOpNumThreads: 4, interOpNumThreads: 1 };
    const open = (model: OnnxModelSource) =>
      (options.shareSessions ?? true)
        ? sharedSession(backend, model, sessionOptions)
        : backend.createSession(model, sessionOptions);

    let bosBeforeVoice: Float32Array | null = null;
    let mimiEncoder: OnnxSession | null = null;
    if (options.voiceCloningModel) {
      bosBeforeVoice = readNpy(await readLocalFile(await fromBundle("bos_before_voice.npy")))
        .data as Float32Array;
      mimiEncoder = await open(options.voiceCloningModel);
    }

    const [textConditioner, flowLmMain, flowLmFlow, mimiDecoder] = await Promise.all([
      open(textConditionerPath),
      open(mainPath),
      open(flowPath),
      open(decoderPath),
    ]);

    return new TTSModel({
      language,
      metadata,
      tokenizer,
      sessions: { textConditioner, flowLmMain, flowLmFlow, mimiDecoder, mimiEncoder },
      temp: options.temp,
      lsdDecodeSteps: options.lsdDecodeSteps,
      noiseClamp: options.noiseClamp,
      eosThreshold: options.eosThreshold,
      quantize,
      bosBeforeVoice,
      random: options.random,
      loadPredefinedVoice: async (name) =>
        readLocalFile(
          await fromKyutai(
            `languages/${language}/embeddings/${name}.safetensors`,
            KYUTAI_VOICES_REVISION,
            `embeddings/${name}.safetensors`,
          ),
        ),
      loadFile: async (pathOrUrl) => readLocalFile(await resolver.local(pathOrUrl)),
    });
  }

  /** Output sample rate (24000). */
  get sampleRate(): number {
    return this.metadata.sample_rate;
  }

  /** Whether audio prompts can be cloned (a Mimi encoder was given). */
  get hasVoiceCloning(): boolean {
    return Boolean(this.#sessions.mimiEncoder && this.#bosBeforeVoice);
  }

  /** Release the sessions (shared sessions are kept; see `disposeSharedSessions`). */
  async dispose(): Promise<void> {
    const s = this.#sessions;
    await Promise.all(
      [s.textConditioner, s.flowLmMain, s.flowLmFlow, s.mimiDecoder, s.mimiEncoder].map((x) =>
        x?.dispose(),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Voice prompts

  /**
   * Create a model state conditioned on a voice prompt.
   *
   * @param audioConditioning One of:
   *   - a predefined voice name (`"alba"`, see `PREDEFINED_VOICES`);
   *   - a `.safetensors` voice state (path, `https://` or `hf://` URL), as
   *     written by `pocket-tts export-voice`;
   *   - a WAV file (path, `https://` or `hf://` URL) to clone, or the samples
   *     themselves (`Float32Array` at 24 kHz, or `{ audio, sampleRate }`).
   *     Cloning needs `voiceCloningModel`.
   * @param options.truncate Keep only the first 30 seconds of an audio prompt.
   */
  async getStateForAudioPrompt(
    audioConditioning: string | Float32Array | AudioPrompt,
    options: { truncate?: boolean } = {},
  ): Promise<ModelState> {
    if (typeof audioConditioning === "string") {
      if (audioConditioning.endsWith(".safetensors")) {
        return this.#importModelState(await this.#loadFile(audioConditioning));
      }
      if ((PREDEFINED_VOICES as readonly string[]).includes(audioConditioning)) {
        if (!this.#loadPredefinedVoice) {
          throw new Error("Cannot use predefined voices: this model has no voice source.");
        }
        return this.#importModelState(await this.#loadPredefinedVoice(audioConditioning));
      }
    }
    if (!this.hasVoiceCloning) throw voiceCloningUnsupported();

    let prompt: AudioPrompt;
    if (typeof audioConditioning === "string") {
      prompt = decodeWav(await this.#loadFile(audioConditioning));
    } else if (audioConditioning instanceof Float32Array) {
      prompt = { audio: audioConditioning, sampleRate: this.sampleRate };
    } else {
      prompt = audioConditioning;
    }
    let audio = prompt.audio;
    if (options.truncate) {
      const maxSamples = Math.floor(30 * prompt.sampleRate);
      if (audio.length > maxSamples) {
        audio = audio.subarray(0, maxSamples);
        logger.info(`Audio truncated to first 30 seconds (${maxSamples} samples)`);
      }
    }
    if (prompt.sampleRate !== this.sampleRate) {
      audio = await resample(audio, prompt.sampleRate, this.sampleRate);
    }
    return this.#stateFromAudio(audio);
  }

  async #stateFromAudio(audio: Float32Array): Promise<ModelState> {
    const encoder = this.#sessions.mimiEncoder!;
    const encoded = await encoder.run({ audio: float32Tensor(audio, [1, 1, audio.length]) });
    const latents = encoded[encoder.outputNames[0]!]!;
    const dim = this.metadata.conditioning_dim;
    const frames = latents.data.length / dim;
    let prompt = latents.data as Float32Array;
    let length = frames;
    if (this.metadata.insert_bos_before_voice && this.#bosBeforeVoice) {
      const withBos = new Float32Array((frames + 1) * dim);
      withBos.set(this.#bosBeforeVoice.subarray(0, dim), 0);
      withBos.set(prompt, dim);
      prompt = withBos;
      length = frames + 1;
    }
    if (length >= this.#flowCacheCapacity) {
      throw new Error(
        `Voice prompt of ${length} frames does not fit the model's ${this.#flowCacheCapacity}-position ` +
          "cache; use a shorter prompt or `truncate: true`.",
      );
    }
    const state = new ModelState(initState(this.metadata.flow_lm_state_manifest));
    await this.#runFlowLm(
      state,
      float32Tensor(new Float32Array(0), [1, 0, this.metadata.latent_dim]),
      float32Tensor(prompt, [1, length, dim]),
    );
    return state;
  }

  /** A state from an exported `.safetensors` voice state (pocket-tts' `_import_model_state`). */
  #importModelState(bytes: Uint8Array): ModelState {
    const tensors = readSafetensors(bytes);
    const byModule = new Map<string, Map<string, FileTensor>>();
    for (const [name, t] of tensors) {
      const slash = name.indexOf("/");
      const module = name.slice(0, slash);
      const key = name.slice(slash + 1);
      let m = byModule.get(module);
      if (!m) {
        m = new Map();
        byModule.set(module, m);
      }
      m.set(key, t);
    }
    const state = initState(this.metadata.flow_lm_state_manifest);
    for (const entry of this.metadata.flow_lm_state_manifest) {
      const moduleState = byModule.get(entry.module);
      if (!moduleState) throw new Error(`Voice state has no tensors for ${entry.module}`);
      if (entry.key === "cache") {
        const src = moduleState.get("cache");
        if (!src) throw new Error(`Voice state has no cache for ${entry.module}`);
        state[entry.input_name] = expandCache(src.data as Float32Array, src.shape, entry.shape);
      } else if (entry.key === "step") {
        state[entry.input_name] = int64Tensor(
          BigInt64Array.of(BigInt(voiceOffset(moduleState))),
          entry.shape,
        );
      }
      // `current_end` is a legacy, always-empty input of the exported graph.
    }
    return new ModelState(state);
  }

  // -------------------------------------------------------------------------
  // Generation

  /**
   * Generate audio from text, yielding 1-D float32 chunks (one 80 ms frame,
   * 1920 samples, each) at `sampleRate` as soon as they are decoded.
   *
   * The text is split into chunks of at most `maxTokens` tokens; each is
   * generated from `modelState` (a copy of it with `copyState`, the default).
   */
  async *generateAudioStream(
    modelState: ModelState,
    textToGenerate: string,
    options: GenerateAudioOptions = {},
  ): AsyncGenerator<Float32Array, void, undefined> {
    const maxTokens = options.maxTokens ?? MAX_TOKEN_PER_CHUNK;
    const copyState = options.copyState ?? true;
    const framesAfterEos = options.framesAfterEos ?? this.modelRecommendedFramesAfterEos;

    // This is a very simplistic way of handling long texts (as pocket-tts does).
    const chunks = splitIntoBestSentences(
      this.tokenizer,
      textToGenerate,
      maxTokens,
      this.padWithSpacesForShortInputs,
      this.removeSemicolons,
    );
    for (const chunk of chunks) {
      let [, framesAfterEosGuess] = prepareTextPrompt(
        chunk,
        this.padWithSpacesForShortInputs,
        this.removeSemicolons,
      );
      framesAfterEosGuess += 2;
      const effectiveFrames = framesAfterEos ?? framesAfterEosGuess;
      yield* this.#generateAudioStreamShortText(modelState, chunk, effectiveFrames, copyState);
    }
  }

  /** Generate the whole audio of `textToGenerate` (pocket-tts' `generate_audio`). */
  async generateAudio(
    modelState: ModelState,
    textToGenerate: string,
    options: GenerateAudioOptions = {},
  ): Promise<Float32Array> {
    const chunks: Float32Array[] = [];
    for await (const chunk of this.generateAudioStream(modelState, textToGenerate, options)) {
      chunks.push(chunk);
    }
    const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  #estimateMaxGenLen(tokenCount: number): number {
    const genLenSec = tokenCount / TOKENS_PER_SECOND_ESTIMATE + GEN_SECONDS_PADDING;
    return Math.ceil(genLenSec * this.metadata.frame_rate);
  }

  async *#generateAudioStreamShortText(
    modelState: ModelState,
    textToGenerate: string,
    framesAfterEos: number,
    copyState: boolean,
  ): AsyncGenerator<Float32Array, void, undefined> {
    const state = copyState ? modelState.clone() : modelState;
    const tokens = this.tokenizer.encode(textToGenerate);
    let maxGenLen = this.#estimateMaxGenLen(tokens.length);

    const currentEnd = flowCurrentEnd(state, this.metadata.flow_lm_state_manifest);
    const available = this.#flowCacheCapacity - currentEnd - tokens.length;
    if (available <= 0) {
      throw new Error(
        `Text chunk of ${tokens.length} tokens does not fit the model's ${this.#flowCacheCapacity}-position ` +
          `cache after a ${currentEnd}-position voice prompt.`,
      );
    }
    if (maxGenLen > available) {
      // DIVERGENCE: pocket-tts grows its KV cache; the exported graph's is fixed.
      logger.warning(
        `Pocket TTS: limiting generation to ${available} frames (of ${maxGenLen}) to fit the ` +
          `${this.#flowCacheCapacity}-position cache`,
      );
      maxGenLen = available;
    }

    // Prompt with the text.
    const conditioned = await this.#sessions.textConditioner.run({
      token_ids: int64Tensor(
        BigInt64Array.from(tokens, (t) => BigInt(t)),
        [1, tokens.length],
      ),
    });
    const textEmbeddings = conditioned[this.#sessions.textConditioner.outputNames[0]!]!;
    const { latent_dim: ldim, conditioning_dim: dim } = this.metadata;
    await this.#runFlowLm(
      state,
      float32Tensor(new Float32Array(0), [1, 0, ldim]),
      float32Tensor(textEmbeddings.data as Float32Array, [1, tokens.length, dim]),
    );

    const emptyText = float32Tensor(new Float32Array(0), [1, 0, dim]);
    const mimiState = initState(this.metadata.mimi_state_manifest);

    // One autoregressive step: the next latent, or null once generation ends.
    let eosStep: number | null = null;
    const step = async (generationStep: number, backbone: Float32Array) => {
      const { conditioning, eosLogit } = await this.#runFlowLm(
        state,
        float32Tensor(backbone, [1, 1, ldim]),
        emptyText,
      );
      if (eosLogit > this.eosThreshold && eosStep === null) eosStep = generationStep;
      if (eosStep !== null && generationStep >= eosStep + framesAfterEos) return null;
      return this.#sampleLatent(conditioning);
    };

    // The backbone input is NaN at the first step: it signals a BOS position.
    let next: Promise<Float32Array | null> | null =
      maxGenLen > 0 ? step(0, new Float32Array(ldim).fill(Number.NaN)) : null;
    let generationStep = 0;
    let reachedEos = false;
    try {
      while (next) {
        const latent = await next;
        next = null;
        if (latent === null) {
          reachedEos = true;
          break;
        }
        generationStep++;
        // Start the next flow-LM step while this frame decodes.
        if (generationStep < maxGenLen) next = step(generationStep, latent);
        yield await this.#decodeFrame(latent, mimiState);
      }
    } finally {
      // A consumer that stops early leaves a step running; let it finish.
      if (next) await next.catch(() => {});
    }
    if (!reachedEos) {
      logger.warning(
        "Maximum generation length reached without EOS, this very often indicates an error.",
      );
    }
  }

  /** Run the flow LM on a sequence and/or conditioning, updating `state`. */
  async #runFlowLm(
    state: ModelState,
    sequence: OnnxTensor,
    textEmbeddings: OnnxTensor,
  ): Promise<FlowStepResult> {
    const session = this.#sessions.flowLmMain;
    const out = await session.run({
      sequence,
      text_embeddings: textEmbeddings,
      ...state.tensors,
    });
    for (const entry of this.metadata.flow_lm_state_manifest) {
      const t = out[entry.output_name];
      if (!t) throw new Error(`flow_lm_main did not return ${entry.output_name}`);
      state.tensors[entry.input_name] = t;
    }
    const conditioning = out.conditioning ?? out[session.outputNames[0]!]!;
    const eos = out.eos_logit ?? out[session.outputNames[1]!]!;
    return { conditioning, eosLogit: (eos.data as Float32Array)[0]! };
  }

  /** Sample the next latent: noise at `temp`, then the LSD flow steps (pocket-tts' `lsd_decode`). */
  async #sampleLatent(conditioning: OnnxTensor): Promise<Float32Array> {
    const ldim = this.metadata.latent_dim;
    const std = this.temp ** 0.5;
    let current = new Float32Array(ldim);
    for (let i = 0; i < ldim; i++) current[i] = this.#noise(std);
    const steps = this.lsdDecodeSteps;
    const session = this.#sessions.flowLmFlow;
    for (let i = 0; i < steps; i++) {
      const s = i / steps;
      const t = (i + 1) / steps;
      const out = await session.run({
        c: float32Tensor(conditioning.data as Float32Array, [1, this.metadata.conditioning_dim]),
        s: float32Tensor(Float32Array.of(s), [1, 1]),
        t: float32Tensor(Float32Array.of(t), [1, 1]),
        x: float32Tensor(current, [1, ldim]),
      });
      const flowDir = out[session.outputNames[0]!]!.data as Float32Array;
      const nextLatent = new Float32Array(ldim);
      for (let j = 0; j < ldim; j++) nextLatent[j] = current[j]! + flowDir[j]! / steps;
      current = nextLatent;
    }
    return current;
  }

  /** One normal (optionally truncated to ±noiseClamp) sample with standard deviation `std`. */
  #noise(std: number): number {
    if (std === 0) return 0;
    for (;;) {
      const v = this.#gaussian() * std;
      if (this.noiseClamp === null || Math.abs(v) <= this.noiseClamp) return v;
    }
  }

  #gaussian(): number {
    if (this.#spareGaussian !== null) {
      const v = this.#spareGaussian;
      this.#spareGaussian = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = this.#random();
    const v = this.#random();
    const r = Math.sqrt(-2 * Math.log(u));
    this.#spareGaussian = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Decode one latent frame with the streaming Mimi decoder. */
  async #decodeFrame(
    latent: Float32Array,
    mimiState: Record<string, OnnxTensor>,
  ): Promise<Float32Array> {
    const session = this.#sessions.mimiDecoder;
    const out = await session.run({
      latent: float32Tensor(latent, [1, 1, this.metadata.latent_dim]),
      ...mimiState,
    });
    for (const entry of this.metadata.mimi_state_manifest) {
      const t = out[entry.output_name];
      if (!t) throw new Error(`mimi_decoder did not return ${entry.output_name}`);
      mimiState[entry.input_name] = t;
    }
    return (out.audio_frame ?? out[session.outputNames[0]!]!).data as Float32Array;
  }
}

/** The position after the voice prompt / previous generation (`_flow_lm_current_end`). */
function flowCurrentEnd(state: ModelState, manifest: readonly StateManifestEntry[]): number {
  const entry = manifest.find((e) => e.key === "step");
  if (!entry) return 0;
  const t = state.tensors[entry.input_name];
  return t ? Number((t.data as BigInt64Array)[0]) : 0;
}

/** The offset stored in an exported voice state's module (current or legacy layout). */
function voiceOffset(moduleState: Map<string, FileTensor>): number {
  const offset = moduleState.get("offset") ?? moduleState.get("step");
  if (offset) return Number(offset.data[0]);
  // Older exports stored the position as the length of `current_end`.
  const currentEnd = moduleState.get("current_end");
  if (currentEnd) return currentEnd.shape[0] ?? 0;
  throw new Error("Voice state has no offset");
}

/** Copy a [2, B, T, H, D] KV cache into the graph's [2, B, capacity, H, D] cache (NaN after T). */
function expandCache(
  src: Float32Array,
  srcShape: readonly number[],
  dstShape: readonly number[],
): OnnxTensor {
  const [two, batch, length, heads, headDim] = srcShape as [number, number, number, number, number];
  const capacity = dstShape[2]!;
  if (dstShape[3] !== heads || dstShape[4] !== headDim || dstShape[0] !== two) {
    throw new Error(
      `Voice state cache shape [${srcShape.join(", ")}] does not match the model's [${dstShape.join(", ")}]`,
    );
  }
  if (length > capacity) {
    throw new Error(
      `Voice state of ${length} positions does not fit the ${capacity}-position cache`,
    );
  }
  const row = heads * headDim;
  const out = new Float32Array(two * batch * capacity * row).fill(Number.NaN);
  for (let k = 0; k < two * batch; k++) {
    out.set(src.subarray(k * length * row, (k + 1) * length * row), k * capacity * row);
  }
  return float32Tensor(out, dstShape);
}

/** Resample float audio (through core's soxr resampler, at 16-bit precision). */
async function resample(
  audio: Float32Array,
  inRate: number,
  outRate: number,
): Promise<Float32Array> {
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i]! * 32767)));
  }
  const out = await createFileResampler().resample(new Uint8Array(pcm.buffer), inRate, outRate);
  const bytes = out.slice();
  const samples = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
  return Float32Array.from(samples, (s) => s / 32768);
}
