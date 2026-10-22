// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The inference engine behind `moonshine_voice.ts`.
 *
 * A TypeScript port of the parts of Moonshine's C++ core (moonshine-ai/moonshine
 * v0.1.5, MIT) that `Transcriber.transcribe_without_streaming` runs, on an
 * `@pipedog/onnx` backend and the same `.ort` model files:
 *
 * - `BinTokenizer` (`core/bin-tokenizer`): token ids to text.
 * - `MoonshineModel` (`core/moonshine-model.cpp`): the non-streaming `tiny` and
 *   `base` encoder/decoder, greedy decoding with a merged KV-cache decoder.
 * - `MoonshineStreamingModel` (`core/moonshine-streaming-model.cpp`): the
 *   streaming architectures (frontend, encoder, adapter, cross K/V and decoder
 *   graphs), used the way the transcriber's batch path uses them.
 * - `VoiceActivityDetector` and `SileroVad` (`core/voice-activity-detector.cpp`,
 *   `core/silero-vad.cpp`): `transcribe_without_streaming` first splits the
 *   audio into speech segments with Silero VAD and transcribes each one.
 * - `resampleAudio` (`core/resampler.cpp`).
 *
 * Arithmetic that the C++ does in 32-bit floats (durations, token budgets, VAD
 * smoothing) is done with `Math.fround` so the same audio takes the same
 * decisions.
 */

import {
  boolTensor,
  float32Tensor,
  int64Tensor,
  type OnnxBackend,
  type OnnxModelSource,
  type OnnxSession,
  type OnnxSessionOptions,
  type OnnxTensor,
  sharedSession,
} from "@pipedog/onnx";

const f32 = Math.fround;

/** The sample rate the models and the VAD run at. */
export const INTERNAL_SAMPLE_RATE = 16000;

/** Session options Moonshine uses for its `.ort` files (`ort_configure_ort_file_session`). */
export const ORT_FILE_SESSION_OPTIONS: OnnxSessionOptions = { graphOptimizationLevel: "extended" };

/** Session options for Silero VAD (`SileroVad::init_onnx_env`). */
export const SILERO_SESSION_OPTIONS: OnnxSessionOptions = {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  graphOptimizationLevel: "all",
};

// ---------------------------------------------------------------------------
// Model files

// Held in a variable so bundlers leave the import alone; it only runs where
// there is a filesystem (Bun, Node, Deno).
const NODE_FS = "node:fs/promises";

interface NodeFs {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

async function nodeFs(): Promise<NodeFs> {
  return (await import(NODE_FS)) as NodeFs;
}

/** `append_path_component`: join a directory and a file name. */
export function appendPathComponent(dir: string, name: string): string {
  if (dir === "" || dir.endsWith("/") || dir.endsWith("\\")) return `${dir}${name}`;
  return `${dir}/${name}`;
}

/** Where a model's files come from: a directory, or bytes in memory. */
export interface ModelFiles {
  /** The model directory (or a description), for error messages. */
  readonly location: string;
  /** Whether the directory itself exists (always true in memory). */
  rootExists(): Promise<boolean>;
  /** Whether `name` exists. */
  exists(name: string): Promise<boolean>;
  /** The full path of `name`, for error messages. */
  pathOf(name: string): string;
  /** The bytes of `name`. */
  read(name: string): Promise<Uint8Array>;
  /** What to hand the ONNX backend for `name`: a path it reads itself, or bytes. */
  modelSource(name: string): Promise<OnnxModelSource>;
}

/** Model files in a directory on disk (Bun, Node, Deno). */
export class DirectoryModelFiles implements ModelFiles {
  readonly location: string;

  constructor(dir: string) {
    this.location = dir;
  }

  async rootExists(): Promise<boolean> {
    try {
      return (await (await nodeFs()).stat(this.location)).isDirectory();
    } catch {
      return false;
    }
  }

  async exists(name: string): Promise<boolean> {
    try {
      return (await (await nodeFs()).stat(this.pathOf(name))).isFile();
    } catch {
      return false;
    }
  }

  pathOf(name: string): string {
    return appendPathComponent(this.location, name);
  }

  async read(name: string): Promise<Uint8Array> {
    const data = await (await nodeFs()).readFile(this.pathOf(name));
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  async modelSource(name: string): Promise<OnnxModelSource> {
    return this.pathOf(name);
  }
}

/** Model files held in memory, by file name (e.g. `{ "tokenizer.bin": bytes, ... }`). */
export class MemoryModelFiles implements ModelFiles {
  readonly location = "<memory>";
  readonly #files: Readonly<Record<string, Uint8Array>>;

  constructor(files: Readonly<Record<string, Uint8Array>>) {
    this.#files = files;
  }

  async rootExists(): Promise<boolean> {
    return true;
  }

  async exists(name: string): Promise<boolean> {
    return this.#files[name] !== undefined;
  }

  pathOf(name: string): string {
    return name;
  }

  async read(name: string): Promise<Uint8Array> {
    const data = this.#files[name];
    if (data === undefined) throw new Error(`Model file '${name}' was not provided`);
    return data;
  }

  async modelSource(name: string): Promise<OnnxModelSource> {
    return this.read(name);
  }
}

/** Open a session, shared per process (the models are stateless) unless `share` is false. */
export function openSession(
  backend: OnnxBackend,
  source: OnnxModelSource,
  options: OnnxSessionOptions,
  share: boolean,
): Promise<OnnxSession> {
  return share ? sharedSession(backend, source, options) : backend.createSession(source, options);
}

// ---------------------------------------------------------------------------
// Tokenizer

const SPACE_STRING = new TextEncoder().encode("▁");
const TRIM_BYTES = new Set([0x20, 0x09]); // trim()'s default " \t"

function replaceAllBytes(input: Uint8Array, from: Uint8Array, to: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  outer: while (i < input.length) {
    if (input[i] === from[0] && i + from.length <= input.length) {
      for (let j = 1; j < from.length; j++) {
        if (input[i + j] !== from[j]) {
          out.push(input[i] as number);
          i++;
          continue outer;
        }
      }
      for (const b of to) out.push(b);
      i += from.length;
      continue;
    }
    out.push(input[i] as number);
    i++;
  }
  return Uint8Array.from(out);
}

function trimBytes(input: Uint8Array): Uint8Array {
  let start = 0;
  let end = input.length;
  while (start < end && TRIM_BYTES.has(input[start] as number)) start++;
  while (end > start && TRIM_BYTES.has(input[end - 1] as number)) end--;
  return input.subarray(start, end);
}

/**
 * Moonshine's `tokenizer.bin` vocabulary (`BinTokenizer`), for decoding.
 *
 * The file is a list of entries, each a length (one byte, or two when the first
 * is >= 128) followed by that many bytes; an entry's index is its token id.
 */
export class BinTokenizer {
  readonly tokensToBytes: Uint8Array[] = [];

  constructor(data: Uint8Array) {
    if (data.length === 0) throw new Error("Tokenizer data is nullptr or empty");
    let offset = 0;
    while (offset < data.length) {
      const firstByte = data[offset] as number;
      offset++;
      if (firstByte === 0) {
        this.tokensToBytes.push(new Uint8Array(0));
        continue;
      }
      let byteCount: number;
      if (firstByte < 128) {
        byteCount = firstByte;
      } else {
        if (offset >= data.length) {
          throw new Error(`Truncated tokenizer data: missing length byte at offset ${offset}`);
        }
        const secondByte = data[offset] as number;
        byteCount = secondByte * 128 + firstByte - 128;
        offset++;
      }
      if (byteCount > data.length - offset) {
        throw new Error(
          `Truncated tokenizer data: token of ${byteCount} bytes at offset ${offset} exceeds input size ${data.length}`,
        );
      }
      this.tokensToBytes.push(data.slice(offset, offset + byteCount));
      offset += byteCount;
    }
    if (this.tokensToBytes.length === 0) {
      throw new Error(`No tokens found in tokenizer input data of size ${data.length}`);
    }
  }

  /**
   * The UTF-8 bytes of `tokens`, skipping special tokens (`<...>`), with the
   * word-boundary marker U+2581 turned into spaces and the ends trimmed.
   */
  tokensToText(tokens: readonly number[], skipSpecials = true): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const token of tokens) {
      const bytes = this.tokensToBytes[token];
      if (bytes === undefined || bytes.length === 0) throw new Error(`Invalid token ${token}`);
      if (
        skipSpecials &&
        bytes.length > 2 &&
        bytes[0] === 0x3c /* < */ &&
        bytes[bytes.length - 1] === 0x3e /* > */
      ) {
        continue;
      }
      parts.push(bytes);
      total += bytes.length;
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return trimBytes(replaceAllBytes(joined, SPACE_STRING, new Uint8Array([0x20])));
  }
}

/**
 * `Transcriber::sanitize_text`: replace each byte that does not start a
 * well-formed UTF-8 sequence with `?`, then decode.
 */
export function sanitizeText(bytes: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  const cont = (k: number) => ((bytes[k] as number) & 0xc0) === 0x80;
  while (i < bytes.length) {
    const remaining = bytes.length - i;
    const c = bytes[i] as number;
    let n = 0;
    if (c < 0x80) n = 1;
    else if ((c & 0xe0) === 0xc0) n = remaining >= 2 && cont(i + 1) ? 2 : 0;
    else if ((c & 0xf0) === 0xe0) n = remaining >= 3 && cont(i + 1) && cont(i + 2) ? 3 : 0;
    else if ((c & 0xf8) === 0xf0)
      n = remaining >= 4 && cont(i + 1) && cont(i + 2) && cont(i + 3) ? 4 : 0;
    if (n === 0) {
      out.push(0x3f); // '?'
      i++;
    } else {
      for (let k = 0; k < n; k++) out.push(bytes[i + k] as number);
      i += n;
    }
  }
  return new TextDecoder("utf-8").decode(Uint8Array.from(out));
}

function argmax(data: Float32Array, start = 0, count = data.length - start): number {
  let best = 0;
  let bestValue = data[start] as number;
  for (let i = 1; i < count; i++) {
    const v = data[start + i] as number;
    if (v > bestValue) {
      bestValue = v;
      best = i;
    }
  }
  return best;
}

function tensorData(outputs: Record<string, OnnxTensor>, name: string): OnnxTensor {
  const t = outputs[name];
  if (t === undefined) throw new Error(`Model output '${name}' is missing`);
  return t;
}

// ---------------------------------------------------------------------------
// Non-streaming model (tiny, base)

const DECODER_START_TOKEN_ID = 1;
const EOS_TOKEN_ID = 2;

/** Layer counts and KV shapes of the non-streaming architectures. */
export const NON_STREAMING_ARCH_PARAMS: Readonly<
  Record<number, { numLayers: number; numKvHeads: number; headDim: number }>
> = {
  0: { numLayers: 6, numKvHeads: 8, headDim: 36 }, // tiny
  1: { numLayers: 8, numKvHeads: 8, headDim: 52 }, // base
};

export interface ModelLoadOptions {
  backend: OnnxBackend;
  /** Share sessions across transcribers (default true; the graphs keep no state). */
  shareSessions: boolean;
  /** Token budget per second of audio (default 6.5). */
  maxTokensPerSecond: number;
}

/** The non-streaming Moonshine encoder/decoder (`MoonshineModel`). */
export class MoonshineModel {
  readonly encoder: OnnxSession;
  readonly decoder: OnnxSession;
  readonly tokenizer: BinTokenizer;
  readonly numLayers: number;
  readonly numKvHeads: number;
  readonly headDim: number;
  readonly maxTokensPerSecond: number;

  constructor(
    encoder: OnnxSession,
    decoder: OnnxSession,
    tokenizer: BinTokenizer,
    modelArch: number,
    maxTokensPerSecond: number,
  ) {
    const params = NON_STREAMING_ARCH_PARAMS[modelArch];
    if (params === undefined) {
      throw new Error(
        `Invalid model architecture: ${modelArch}, must be MOONSHINE_MODEL_ARCH_TINY (0) or MOONSHINE_MODEL_ARCH_BASE (1)`,
      );
    }
    this.encoder = encoder;
    this.decoder = decoder;
    this.tokenizer = tokenizer;
    this.numLayers = params.numLayers;
    this.numKvHeads = params.numKvHeads;
    this.headDim = params.headDim;
    this.maxTokensPerSecond = maxTokensPerSecond;
  }

  /** Load `encoder_model.ort`, `decoder_model_merged.ort` and `tokenizer.bin`. */
  static async load(
    files: ModelFiles,
    modelArch: number,
    options: ModelLoadOptions,
  ): Promise<MoonshineModel> {
    const open = async (name: string) =>
      openSession(
        options.backend,
        await files.modelSource(name),
        ORT_FILE_SESSION_OPTIONS,
        options.shareSessions,
      );
    const encoder = await open("encoder_model.ort");
    const decoder = await open("decoder_model_merged.ort");
    const tokenizer = new BinTokenizer(await files.read("tokenizer.bin"));
    return new MoonshineModel(encoder, decoder, tokenizer, modelArch, options.maxTokensPerSecond);
  }

  /** `MoonshineModel::transcribe`: 16 kHz audio to text (UTF-8 bytes). */
  async transcribe(audio: Float32Array): Promise<Uint8Array> {
    if (audio.length === 0) throw new Error("Audio data is nullptr or empty");
    const n = audio.length;

    // Encoder: the audio, plus an all-ones attention mask when the export has one.
    const encoderFeeds: Record<string, OnnxTensor> = {
      [this.encoder.inputNames[0] as string]: float32Tensor(audio, [1, n]),
    };
    let attentionMask: OnnxTensor | null = null;
    if (this.encoder.inputNames.length > 1) {
      attentionMask = int64Tensor(new BigInt64Array(n).fill(1n), [1, n]);
      encoderFeeds[this.encoder.inputNames[1] as string] = attentionMask;
    }
    const encoderOutputs = await this.encoder.run(encoderFeeds);
    const lastHiddenState = tensorData(encoderOutputs, this.encoder.outputNames[0] as string);

    const decoderInputCount = this.decoder.inputNames.length;
    const v1 = this.numLayers * 4 + 3;
    const v2 = this.numLayers * 4 + 4;
    if (decoderInputCount !== v1 && decoderInputCount !== v2) {
      throw new Error(
        `Expected decoder input count to be ${v1} or ${v2}, but got ${decoderInputCount}. ` +
          "This often indicates you're specifying the wrong model architecture " +
          "(for example tiny instead of base).",
      );
    }
    const decoderInputs = new Set(this.decoder.inputNames);

    const audioDuration = f32(n / 16000);
    const maxLen = Math.ceil(f32(audioDuration * f32(this.maxTokensPerSecond)));

    const layerSuffixes: string[] = [];
    const pastKeyValues = new Map<string, OnnxTensor>();
    for (let i = 0; i < this.numLayers; i++) {
      for (const a of ["decoder", "encoder"]) {
        for (const b of ["key", "value"]) {
          const suffix = `${i}.${a}.${b}`;
          layerSuffixes.push(suffix);
          pastKeyValues.set(
            `past_key_values.${suffix}`,
            float32Tensor(new Float32Array(this.numKvHeads * this.headDim), [
              1,
              this.numKvHeads,
              1,
              this.headDim,
            ]),
          );
        }
      }
    }

    const tokens: number[] = [DECODER_START_TOKEN_ID];
    let inputIds: number[] = [DECODER_START_TOKEN_ID];
    for (let tokenIndex = 0; tokenIndex < maxLen; tokenIndex++) {
      const useCacheBranch = tokenIndex > 0;
      const feeds: Record<string, OnnxTensor> = {
        input_ids: int64Tensor(BigInt64Array.from(inputIds.map(BigInt)), [1, inputIds.length]),
        encoder_hidden_states: lastHiddenState,
        use_cache_branch: boolTensor(new Uint8Array([useCacheBranch ? 1 : 0]), [1]),
      };
      // The attention-enabled decoder export has no mask input.
      if (attentionMask !== null && decoderInputs.has("encoder_attention_mask")) {
        feeds.encoder_attention_mask = attentionMask;
      }
      for (const [name, value] of pastKeyValues) {
        if (!decoderInputs.has(name)) throw new Error(`Decoder has no input ${name}`);
        feeds[name] = value;
      }
      for (const name of this.decoder.inputNames) {
        if (feeds[name] === undefined) throw new Error(`Decoder input ${name} is nullptr`);
      }

      const outputs = await this.decoder.run(feeds);
      const logits = tensorData(outputs, this.decoder.outputNames[0] as string);

      // Carry the present key/values over as the next step's past. The encoder
      // (cross-attention) ones are computed once, on the first step.
      for (const suffix of layerSuffixes) {
        if (!useCacheBranch || suffix.includes("decoder")) {
          pastKeyValues.set(`past_key_values.${suffix}`, tensorData(outputs, `present.${suffix}`));
        }
      }

      const nextToken = argmax(logits.data as Float32Array);
      tokens.push(nextToken);
      if (nextToken === EOS_TOKEN_ID) break;
      inputIds = [nextToken];
    }

    return this.tokenizer.tokensToText(tokens);
  }
}

// ---------------------------------------------------------------------------
// Streaming model (tiny-, base-, small-, medium-streaming)

/** `streaming_config.json` (`MoonshineStreamingConfig`). */
export interface MoonshineStreamingConfig {
  encoderDim: number;
  decoderDim: number;
  depth: number;
  nheads: number;
  headDim: number;
  vocabSize: number;
  bosId: number;
  eosId: number;
  frameLen: number;
  totalLookahead: number;
  dModelFrontend: number;
  c1: number;
  c2: number;
  maxSeqLen: number;
}

/**
 * Parse `streaming_config.json` the way the C++ does (`parse_config_json`):
 * each value is the integer after the first `"key":` in the text, or 0.
 * Returns null when `depth`, `decoder_dim` or `vocab_size` is missing.
 */
export function parseStreamingConfig(json: string): MoonshineStreamingConfig | null {
  const getInt = (key: string): number => {
    const search = `"${key}":`;
    let pos = json.indexOf(search);
    if (pos < 0) return 0;
    pos += search.length;
    while (pos < json.length && (json[pos] === " " || json[pos] === "\t")) pos++;
    let negative = false;
    if (json[pos] === "-") {
      negative = true;
      pos++;
    }
    let val = 0;
    while (pos < json.length && (json[pos] as string) >= "0" && (json[pos] as string) <= "9") {
      val = val * 10 + (json.charCodeAt(pos) - 48);
      pos++;
    }
    return negative ? -val : val;
  };
  const maxSeq = getInt("max_seq_len");
  const config: MoonshineStreamingConfig = {
    encoderDim: getInt("encoder_dim"),
    decoderDim: getInt("decoder_dim"),
    depth: getInt("depth"),
    nheads: getInt("nheads"),
    headDim: getInt("head_dim"),
    vocabSize: getInt("vocab_size"),
    bosId: getInt("bos_id"),
    eosId: getInt("eos_id"),
    frameLen: getInt("frame_len"),
    totalLookahead: getInt("total_lookahead"),
    dModelFrontend: getInt("d_model_frontend"),
    c1: getInt("c1"),
    c2: getInt("c2"),
    maxSeqLen: maxSeq > 0 ? maxSeq : 448,
  };
  return config.depth > 0 && config.decoderDim > 0 && config.vocabSize > 0 ? config : null;
}

/** A growable float32 buffer. */
class FloatBuffer {
  data = new Float32Array(0);
  length = 0;

  append(values: Float32Array): void {
    if (this.length + values.length > this.data.length) {
      const grown = new Float32Array(Math.max(this.length + values.length, this.data.length * 2));
      grown.set(this.data.subarray(0, this.length));
      this.data = grown;
    }
    this.data.set(values, this.length);
    this.length += values.length;
  }

  view(start = 0, end = this.length): Float32Array {
    return this.data.subarray(start, end);
  }

  clear(): void {
    this.data = new Float32Array(0);
    this.length = 0;
  }
}

/** Per-utterance state of the streaming model (`MoonshineStreamingState`). */
export class MoonshineStreamingState {
  sampleBuffer: Float32Array = new Float32Array(79);
  sampleLen = 0n;
  conv1Buffer: Float32Array = new Float32Array(0);
  conv2Buffer: Float32Array = new Float32Array(0);
  frameCount = 0n;
  readonly accumulatedFeatures = new FloatBuffer();
  accumulatedFeatureCount = 0;
  encoderFramesEmitted = 0;
  adapterPosOffset = 0n;
  readonly memory = new FloatBuffer();
  memoryLen = 0;
  kSelf: Float32Array = new Float32Array(0);
  vSelf: Float32Array = new Float32Array(0);
  cacheSeqLen = 0;
  kCross: Float32Array = new Float32Array(0);
  vCross: Float32Array = new Float32Array(0);
  crossLen = 0;
  crossKvValid = false;

  reset(config: MoonshineStreamingConfig): void {
    this.sampleBuffer = new Float32Array(79);
    this.sampleLen = 0n;
    this.conv1Buffer = new Float32Array(config.dModelFrontend * 4);
    this.conv2Buffer = new Float32Array(config.c1 * 4);
    this.frameCount = 0n;
    this.accumulatedFeatures.clear();
    this.accumulatedFeatureCount = 0;
    this.encoderFramesEmitted = 0;
    this.adapterPosOffset = 0n;
    this.memory.clear();
    this.memoryLen = 0;
    this.kSelf = new Float32Array(0);
    this.vSelf = new Float32Array(0);
    this.cacheSeqLen = 0;
    this.kCross = new Float32Array(0);
    this.vCross = new Float32Array(0);
    this.crossLen = 0;
    this.crossKvValid = false;
  }
}

/** A frontend weight computed once at load (`FrontendSplitWeight`). */
interface FrontendSplitWeight {
  name: string;
  tensor: OnnxTensor;
}

/**
 * Samples per frontend call in the batch path: whole 80 ms chunks, as the
 * exported frontend graphs require (see `transcribeSegment`).
 */
const STREAMING_CHUNK_SIZE = 1280;

/** Token cap for one streamed segment, whatever its duration. */
const STREAMING_MAX_TOKENS = 256;

/** The streaming Moonshine model (`MoonshineStreamingModel`). */
export class MoonshineStreamingModel {
  readonly config: MoonshineStreamingConfig;
  readonly frontend: OnnxSession;
  readonly encoder: OnnxSession;
  readonly adapter: OnnxSession;
  readonly crossKv: OnnxSession;
  readonly decoderKv: OnnxSession;
  readonly tokenizer: BinTokenizer;
  readonly frontendSplitWeights: readonly FrontendSplitWeight[];
  readonly maxTokensPerSecond: number;

  constructor(parts: {
    config: MoonshineStreamingConfig;
    frontend: OnnxSession;
    encoder: OnnxSession;
    adapter: OnnxSession;
    crossKv: OnnxSession;
    decoderKv: OnnxSession;
    tokenizer: BinTokenizer;
    frontendSplitWeights: readonly FrontendSplitWeight[];
    maxTokensPerSecond: number;
  }) {
    this.config = parts.config;
    this.frontend = parts.frontend;
    this.encoder = parts.encoder;
    this.adapter = parts.adapter;
    this.crossKv = parts.crossKv;
    this.decoderKv = parts.decoderKv;
    this.tokenizer = parts.tokenizer;
    this.frontendSplitWeights = parts.frontendSplitWeights;
    this.maxTokensPerSecond = parts.maxTokensPerSecond;
  }

  /**
   * Load a streaming model directory (`MoonshineStreamingModel::load`).
   *
   * The frontend ships either as `frontend.ort`, or (from the August 2026
   * quantizations on) as a split pair: `frontend.model.ort`, a graph whose
   * float weights are extra inputs, and `frontend.weights.ort`, an input-less
   * graph that dequantizes the int8 weights once. Like the C++, the pair is
   * preferred when both files exist: the weights graph is run once at load and
   * its outputs are fed to every frontend run.
   */
  static async load(
    files: ModelFiles,
    options: ModelLoadOptions,
  ): Promise<MoonshineStreamingModel> {
    const configJson = new TextDecoder().decode(await files.read("streaming_config.json"));
    const config = parseStreamingConfig(configJson);
    if (config === null) throw new Error("Failed to parse streaming config JSON");

    const open = async (name: string) =>
      openSession(
        options.backend,
        await files.modelSource(name),
        ORT_FILE_SESSION_OPTIONS,
        options.shareSessions,
      );

    const split =
      (await files.exists("frontend.model.ort")) && (await files.exists("frontend.weights.ort"));
    let frontend: OnnxSession;
    let frontendSplitWeights: FrontendSplitWeight[] = [];
    if (split) {
      frontend = await open("frontend.model.ort");
      // Run once and released: not shared, since nothing else needs it.
      const weightsSession = await options.backend.createSession(
        await files.modelSource("frontend.weights.ort"),
        ORT_FILE_SESSION_OPTIONS,
      );
      try {
        frontendSplitWeights = await collectFrontendSplitWeights(weightsSession);
      } finally {
        await weightsSession.dispose();
      }
    } else {
      frontend = await open("frontend.ort");
    }
    const encoder = await open("encoder.ort");
    const adapter = await open("adapter.ort");
    const crossKv = await open("cross_kv.ort");
    const decoderKv = await open("decoder_kv.ort");
    const tokenizer = new BinTokenizer(await files.read("tokenizer.bin"));
    return new MoonshineStreamingModel({
      config,
      frontend,
      encoder,
      adapter,
      crossKv,
      decoderKv,
      tokenizer,
      frontendSplitWeights,
      maxTokensPerSecond: options.maxTokensPerSecond,
    });
  }

  createState(): MoonshineStreamingState {
    const state = new MoonshineStreamingState();
    state.reset(this.config);
    return state;
  }

  /** `process_audio_chunk`: run the frontend on one chunk, accumulating features. */
  async processAudioChunk(state: MoonshineStreamingState, chunk: Float32Array): Promise<number> {
    if (chunk.length === 0) return 0;
    const cfg = this.config;
    const feeds: Record<string, OnnxTensor> = {
      audio_chunk: float32Tensor(chunk, [1, chunk.length]),
      sample_buffer: float32Tensor(state.sampleBuffer, [1, 79]),
      sample_len: int64Tensor(BigInt64Array.of(state.sampleLen), [1]),
      conv1_buffer: float32Tensor(state.conv1Buffer, [1, cfg.dModelFrontend, 4]),
      conv2_buffer: float32Tensor(state.conv2Buffer, [1, cfg.c1, 4]),
      frame_count: int64Tensor(BigInt64Array.of(state.frameCount), [1]),
    };
    for (const weight of this.frontendSplitWeights) feeds[weight.name] = weight.tensor;
    const out = await this.frontend.run(feeds);

    const features = tensorData(out, "features");
    const numFeatures = features.dims[1] as number;
    const featDim = features.dims[2] as number;
    if (numFeatures > 0) {
      state.accumulatedFeatures.append(
        (features.data as Float32Array).subarray(0, numFeatures * featDim),
      );
      state.accumulatedFeatureCount += numFeatures;
    }
    state.sampleBuffer = Float32Array.from(
      (tensorData(out, "sample_buffer_out").data as Float32Array).subarray(0, 79),
    );
    state.sampleLen = (tensorData(out, "sample_len_out").data as BigInt64Array)[0] as bigint;
    state.conv1Buffer = Float32Array.from(
      (tensorData(out, "conv1_buffer_out").data as Float32Array).subarray(
        0,
        cfg.dModelFrontend * 4,
      ),
    );
    state.conv2Buffer = Float32Array.from(
      (tensorData(out, "conv2_buffer_out").data as Float32Array).subarray(0, cfg.c1 * 4),
    );
    state.frameCount = (tensorData(out, "frame_count_out").data as BigInt64Array)[0] as bigint;
    return numFeatures;
  }

  /** `encode`: run the encoder and adapter on the stable new frames, appending to memory. */
  async encode(state: MoonshineStreamingState, isFinal: boolean): Promise<number> {
    const cfg = this.config;
    const totalFeatures = state.accumulatedFeatureCount;
    if (totalFeatures === 0) return 0;
    const stableCount = isFinal ? totalFeatures : Math.max(0, totalFeatures - cfg.totalLookahead);
    const newFrames = stableCount - state.encoderFramesEmitted;
    if (newFrames <= 0) return 0;

    // The encoder uses a sliding window with a fixed per-layer left context.
    const leftContextFrames = 16 * cfg.depth;
    const windowStart = Math.max(0, state.encoderFramesEmitted - leftContextFrames);
    const windowSize = totalFeatures - windowStart;
    const features = state.accumulatedFeatures.view(
      windowStart * cfg.encoderDim,
      (windowStart + windowSize) * cfg.encoderDim,
    );
    const encOut = await this.encoder.run({
      features: float32Tensor(features, [1, windowSize, cfg.encoderDim]),
    });
    const encoded = tensorData(encOut, "encoded");
    const totalEncoded = encoded.dims[1] as number;
    const startIdx = state.encoderFramesEmitted - windowStart;
    if (startIdx < 0 || startIdx + newFrames > totalEncoded) {
      throw new Error(
        `Encoder window misaligned: start_idx=${startIdx}, new_frames=${newFrames}, total=${totalEncoded}`,
      );
    }
    const newEncoded = Float32Array.from(
      (encoded.data as Float32Array).subarray(
        startIdx * cfg.encoderDim,
        (startIdx + newFrames) * cfg.encoderDim,
      ),
    );
    const adapterOut = await this.adapter.run({
      encoded: float32Tensor(newEncoded, [1, newFrames, cfg.encoderDim]),
      pos_offset: int64Tensor(BigInt64Array.of(state.adapterPosOffset), [1]),
    });
    const memory = tensorData(adapterOut, "memory").data as Float32Array;
    state.memory.append(memory.subarray(0, newFrames * cfg.decoderDim));
    state.memoryLen += newFrames;
    // Memory changed, so the cross-attention K/V must be recomputed.
    state.crossKvValid = false;
    state.encoderFramesEmitted = stableCount;
    state.adapterPosOffset += BigInt(newFrames);
    return newFrames;
  }

  /** `compute_cross_kv`: cross-attention keys and values from the current memory. */
  async computeCrossKv(state: MoonshineStreamingState): Promise<void> {
    const cfg = this.config;
    if (state.memoryLen === 0) throw new Error("Failed to compute cross K/V: empty memory");
    const out = await this.crossKv.run({
      memory: float32Tensor(state.memory.view(), [1, state.memoryLen, cfg.decoderDim]),
    });
    const k = tensorData(out, "k_cross");
    const v = tensorData(out, "v_cross");
    if (k.dims.length !== 5) throw new Error("Expected 5D cross KV tensor");
    const crossLen = k.dims[3] as number;
    const size = cfg.depth * cfg.nheads * crossLen * cfg.headDim;
    state.kCross = (k.data as Float32Array).subarray(0, size);
    state.vCross = (v.data as Float32Array).subarray(0, size);
    state.crossLen = crossLen;
    state.crossKvValid = true;
  }

  /** `run_decoder_with_cross_kv`: decode `tokens` against the cached K/V; returns all logits. */
  async runDecoderWithCrossKv(
    state: MoonshineStreamingState,
    tokens: readonly number[],
  ): Promise<Float32Array> {
    const cfg = this.config;
    if (!state.crossKvValid || state.crossLen === 0) {
      throw new Error("Cross K/V not valid, call compute_cross_kv first");
    }
    if (tokens.length === 0) throw new Error("No tokens to decode");
    const cacheLen = state.cacheSeqLen;
    const kvSelfShape = [cfg.depth, 1, cfg.nheads, cacheLen, cfg.headDim];
    const kvSelfSize = cfg.depth * cfg.nheads * cacheLen * cfg.headDim;
    if (state.kSelf.length !== kvSelfSize) {
      // std::vector::resize: keep the prefix, zero-fill the rest.
      const k = new Float32Array(kvSelfSize);
      k.set(state.kSelf.subarray(0, Math.min(kvSelfSize, state.kSelf.length)));
      const v = new Float32Array(kvSelfSize);
      v.set(state.vSelf.subarray(0, Math.min(kvSelfSize, state.vSelf.length)));
      state.kSelf = k;
      state.vSelf = v;
    }
    const kvCrossShape = [cfg.depth, 1, cfg.nheads, state.crossLen, cfg.headDim];
    const out = await this.decoderKv.run({
      token: int64Tensor(BigInt64Array.from(tokens.map(BigInt)), [1, tokens.length]),
      k_self: float32Tensor(state.kSelf, kvSelfShape),
      v_self: float32Tensor(state.vSelf, kvSelfShape),
      out_k_cross: float32Tensor(state.kCross, kvCrossShape),
      out_v_cross: float32Tensor(state.vCross, kvCrossShape),
    });
    const logits = (tensorData(out, "logits").data as Float32Array).subarray(
      0,
      tokens.length * cfg.vocabSize,
    );
    const kOut = tensorData(out, "out_k_self");
    const newCacheLen = kOut.dims[3] as number;
    const newSize = cfg.depth * cfg.nheads * newCacheLen * cfg.headDim;
    state.kSelf = (kOut.data as Float32Array).subarray(0, newSize);
    state.vSelf = (tensorData(out, "out_v_self").data as Float32Array).subarray(0, newSize);
    state.cacheSeqLen = newCacheLen;
    return logits;
  }

  /** `decode_step`: one token in, the next token's logits out. */
  async decodeStep(state: MoonshineStreamingState, token: number): Promise<Float32Array> {
    const cfg = this.config;
    if (state.memoryLen === 0) {
      // Nothing encoded yet: point argmax at EOS.
      const logits = new Float32Array(cfg.vocabSize);
      if (cfg.eosId >= 0 && cfg.eosId < cfg.vocabSize) logits[cfg.eosId] = 1;
      return logits;
    }
    if (!state.crossKvValid) await this.computeCrossKv(state);
    const logits = await this.runDecoderWithCrossKv(state, [token]);
    return logits.subarray(0, cfg.vocabSize);
  }

  /** `decoder_reset`: drop the self-attention cache (the cross K/V stays valid). */
  decoderReset(state: MoonshineStreamingState): void {
    state.kSelf = new Float32Array(0);
    state.vSelf = new Float32Array(0);
    state.cacheSeqLen = 0;
  }

  /**
   * Transcribe one complete speech segment, as
   * `Transcriber::transcribe_segment_with_streaming_model` does for a new,
   * final segment: frontend over whole 80 ms chunks, one final encode, then
   * greedy decoding from BOS with up to `ceil(seconds * maxTokensPerSecond)`
   * (at most 256) tokens.
   *
   * Only whole 1280-sample chunks reach the frontend; like the C++, a
   * remainder shorter than that is not transcribed (the English graphs
   * published before 2026-08-23 mishandle partial chunks).
   */
  async transcribeSegment(
    state: MoonshineStreamingState,
    audio: Float32Array,
    isFinal = true,
  ): Promise<Uint8Array> {
    if (audio.length === 0) return new Uint8Array(0);
    const cfg = this.config;
    state.reset(cfg);

    const chunkCount = Math.floor(audio.length / STREAMING_CHUNK_SIZE);
    for (let i = 0; i < chunkCount; i++) {
      const offset = i * STREAMING_CHUNK_SIZE;
      await this.processAudioChunk(state, audio.subarray(offset, offset + STREAMING_CHUNK_SIZE));
    }
    await this.encode(state, isFinal);
    if (state.memoryLen === 0) return new Uint8Array(0);

    this.decoderReset(state);
    const durationSec = f32(audio.length / INTERNAL_SAMPLE_RATE);
    const maxTokens = Math.min(
      Math.ceil(f32(durationSec * f32(this.maxTokensPerSecond))),
      STREAMING_MAX_TOKENS,
    );
    const tokens: number[] = [cfg.bosId];
    let currentToken = cfg.bosId;
    for (let step = 0; step < maxTokens; step++) {
      const logits = await this.decodeStep(state, currentToken);
      const nextToken = argmax(logits, 0, cfg.vocabSize);
      tokens.push(nextToken);
      currentToken = nextToken;
      if (nextToken === cfg.eosId) break;
    }
    return this.tokenizer.tokensToText(tokens);
  }
}

async function collectFrontendSplitWeights(session: OnnxSession): Promise<FrontendSplitWeight[]> {
  if (session.outputNames.length === 0) {
    throw new Error("frontend weights model produced no outputs");
  }
  const outputs = await session.run({});
  return session.outputNames.map((name) => {
    const t = tensorData(outputs, name);
    if (t.type !== "float32") throw new Error(`frontend split weight ${name} is not float32`);
    // Copy: the weights outlive the session that produced them.
    return { name, tensor: float32Tensor(Float32Array.from(t.data as Float32Array), t.dims) };
  });
}

// ---------------------------------------------------------------------------
// Resampling (core/resampler.cpp)

/** `resample_audio`: box-filter downsampling, linear-interpolation upsampling. */
export function resampleAudio(
  audio: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  const inRate = f32(inputSampleRate);
  const outRate = f32(outputSampleRate);
  if (inRate === outRate) return audio;
  const n = audio.length;
  const outSize = Math.trunc(f32(f32(f32(n) * outRate) / inRate));
  const out = new Float32Array(outSize);
  const ratio = f32(inRate / outRate);
  if (inRate > outRate) {
    for (let i = 0; i < outSize; i++) {
      const startIdx = Math.trunc(f32(f32(i) * ratio));
      let endIdx = Math.trunc(f32(f32(i + 1) * ratio));
      if (endIdx >= n) endIdx = n - 1;
      let sum = 0;
      let count = 0;
      for (let j = startIdx; j <= endIdx; j++) {
        sum = f32(sum + (audio[j] as number));
        count++;
      }
      out[i] = count > 0 ? f32(sum / count) : 0;
    }
  } else {
    for (let i = 0; i < outSize; i++) {
      const pos = f32(f32(i) * ratio);
      const index = Math.trunc(pos);
      const fraction = f32(pos - index);
      if (index >= n - 1) {
        out[i] = audio[n - 1] as number;
      } else {
        const s0 = audio[index] as number;
        const s1 = audio[index + 1] as number;
        out[i] = f32(s0 + f32(fraction * f32(s1 - s0)));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Voice activity detection (core/silero-vad.cpp, core/voice-activity-detector.cpp)

const SILERO_CONTEXT_SAMPLES = 64;
const SILERO_WINDOW_SAMPLES = 512; // 32 ms at 16 kHz
const SILERO_STATE_SIZE = 2 * 1 * 128;

/**
 * Silero VAD with its recurrent state (`SileroVad`).
 *
 * Moonshine keeps one instance per process, shared by every transcriber, and
 * never resets its state; `sharedSileroVad()` does the same.
 */
export class SileroVad {
  readonly session: OnnxSession;
  #state = new Float32Array(SILERO_STATE_SIZE);
  #context = new Float32Array(SILERO_CONTEXT_SAMPLES);
  readonly #sr = int64Tensor(BigInt64Array.of(16000n), []);

  constructor(session: OnnxSession) {
    this.session = session;
  }

  /** Speech probability of one 512-sample chunk, with the previous chunk's tail as context. */
  async predict(chunk: Float32Array): Promise<number> {
    const input = new Float32Array(SILERO_CONTEXT_SAMPLES + SILERO_WINDOW_SAMPLES);
    input.set(this.#context);
    input.set(chunk.subarray(0, SILERO_WINDOW_SAMPLES), SILERO_CONTEXT_SAMPLES);
    const out = await this.session.run({
      input: float32Tensor(input, [1, input.length]),
      state: float32Tensor(this.#state, [2, 1, 128]),
      sr: this.#sr,
    });
    const probability = (tensorData(out, "output").data as Float32Array)[0] as number;
    this.#state = Float32Array.from(
      (tensorData(out, "stateN").data as Float32Array).subarray(0, SILERO_STATE_SIZE),
    );
    this.#context = input.slice(input.length - SILERO_CONTEXT_SAMPLES);
    return probability;
  }
}

let globalSileroVad: Promise<SileroVad> | null = null;

/**
 * The process-wide Silero VAD, created on first use from `model` on `backend`
 * (later calls get the same instance, whatever they pass).
 */
export function sharedSileroVad(backend: OnnxBackend, model: OnnxModelSource): Promise<SileroVad> {
  if (globalSileroVad === null) {
    const created = sharedSession(backend, model, SILERO_SESSION_OPTIONS).then(
      (session) => new SileroVad(session),
    );
    globalSileroVad = created;
    created.catch(() => {
      if (globalSileroVad === created) globalSileroVad = null;
    });
  }
  return globalSileroVad;
}

/** Forget the process-wide Silero VAD (its state and session); for tests. */
export function resetSharedSileroVad(): void {
  globalSileroVad = null;
}

/** A detected stretch of speech (`VoiceActivitySegment`). */
export interface VoiceActivitySegment {
  audioData: Float32Array;
  startTime: number;
  endTime: number;
  /** The speech in this segment has ended. */
  isComplete: boolean;
  /** The segment changed in the last `processAudio` call. */
  justUpdated: boolean;
}

function secondsFromSampleCount(sampleCount: number): number {
  return f32(sampleCount / INTERNAL_SAMPLE_RATE);
}

/**
 * Splits audio into speech segments (`VoiceActivityDetector`).
 *
 * Every 512 samples it averages the last `windowSize` Silero probabilities;
 * speech starts when the average rises above `threshold` (taking up to
 * `lookBehindSampleCount` earlier samples with it) and ends when it falls back.
 * A segment longer than two thirds of `maxSegmentSampleCount` has its score
 * faded towards zero, so it ends by that length.
 */
export class VoiceActivityDetector {
  readonly threshold: number;
  readonly windowSize: number;
  readonly hopSize: number;
  readonly lookBehindSampleCount: number;
  readonly maxSegmentSampleCount: number;
  readonly #vad: () => Promise<SileroVad>;

  #isActive = false;
  readonly #probabilityWindow: Float32Array;
  #probabilityWindowIndex = 0;
  #segments: VoiceActivitySegment[] = [];
  #samplesProcessedCount = 0;
  #currentSegment = new FloatBuffer();
  readonly #lookBehind: Float32Array;
  #remainder = new Float32Array(0);
  #previousIsVoice = false;

  constructor(
    vad: () => Promise<SileroVad>,
    threshold = 0.5,
    windowSize = 32,
    hopSize = 512,
    lookBehindSampleCount = 4096,
    maxSegmentSampleCount = 15 * 16000,
  ) {
    this.#vad = vad;
    this.threshold = f32(threshold);
    this.windowSize = windowSize;
    this.hopSize = hopSize;
    this.lookBehindSampleCount = lookBehindSampleCount;
    this.maxSegmentSampleCount = maxSegmentSampleCount;
    this.#probabilityWindow = new Float32Array(windowSize);
    this.#lookBehind = new Float32Array(lookBehindSampleCount);
  }

  get isActive(): boolean {
    return this.#isActive;
  }

  get segments(): readonly VoiceActivitySegment[] {
    return this.#segments;
  }

  /**
   * Start a new session. Like the C++, the probability window and the
   * look-behind buffer keep their contents from the previous session (only
   * their sizes are reset, which never change).
   */
  start(): void {
    this.#isActive = true;
    this.#samplesProcessedCount = 0;
    this.#segments = [];
    this.#currentSegment = new FloatBuffer();
    this.#remainder = new Float32Array(0);
    this.#probabilityWindowIndex = 0;
    this.#previousIsVoice = false;
  }

  /** Stop, closing any open segment. */
  stop(): void {
    this.deactivate();
    if (this.#previousIsVoice) this.#onVoiceEnd();
  }

  deactivate(): void {
    this.#isActive = false;
  }

  async processAudio(audio: Float32Array, sampleRate: number): Promise<void> {
    if (!this.#isActive) return;
    for (const segment of this.#segments) segment.justUpdated = false;
    const resampled = resampleAudio(audio, sampleRate, INTERNAL_SAMPLE_RATE);
    const buffer = new Float32Array(this.#remainder.length + resampled.length);
    buffer.set(this.#remainder);
    buffer.set(resampled, this.#remainder.length);
    let offset = 0;
    while (buffer.length - offset >= this.hopSize) {
      await this.#processAudioChunk(buffer.subarray(offset, offset + this.hopSize));
      offset += this.hopSize;
    }
    this.#remainder = buffer.slice(offset);
  }

  async #processAudioChunk(chunk: Float32Array): Promise<void> {
    const size = chunk.length;
    this.#samplesProcessedCount += size;
    this.#lookBehind.copyWithin(0, size);
    this.#lookBehind.set(chunk, this.#lookBehind.length - size);

    let smoothedProbability = 0;
    if (this.threshold > 0) {
      const probability = await (await this.#vad()).predict(chunk);
      this.#probabilityWindow[this.#probabilityWindowIndex] = probability;
      this.#probabilityWindowIndex = (this.#probabilityWindowIndex + 1) % this.windowSize;
      let sum = 0;
      for (const p of this.#probabilityWindow) sum = f32(sum + p);
      smoothedProbability = f32(sum / this.windowSize);
    } else {
      // A zero threshold treats all audio as voice; long input is still split below.
      smoothedProbability = 1;
    }
    // Past two thirds of the maximum segment length, fade the score linearly to
    // zero at the maximum, so the segment is sure to end.
    const fadeSampleCount = Math.floor((this.maxSegmentSampleCount * 2) / 3);
    if (this.maxSegmentSampleCount && this.#currentSegment.length > fadeSampleCount) {
      const fadeFactor = f32(
        f32(this.#currentSegment.length - fadeSampleCount) / f32(fadeSampleCount),
      );
      smoothedProbability = f32(smoothedProbability * fadeFactor);
    }
    const currentIsVoice = smoothedProbability > this.threshold;
    if (currentIsVoice && !this.#previousIsVoice) {
      // Never look back to before the start of the stream.
      const lookBehindSize = Math.min(this.lookBehindSampleCount, this.#samplesProcessedCount);
      this.#currentSegment = new FloatBuffer();
      this.#currentSegment.append(
        this.#lookBehind.subarray(this.#lookBehind.length - lookBehindSize),
      );
      this.#onVoiceStart();
    } else if (!currentIsVoice && this.#previousIsVoice) {
      this.#currentSegment.append(chunk);
      this.#onVoiceEnd();
      this.#currentSegment = new FloatBuffer();
    } else if (currentIsVoice && this.#previousIsVoice) {
      this.#currentSegment.append(chunk);
      this.#onVoiceContinuing();
    }
    this.#previousIsVoice = currentIsVoice;
  }

  #onVoiceStart(): void {
    const currentTime = secondsFromSampleCount(this.#samplesProcessedCount);
    this.#segments.push({
      audioData: this.#currentSegment.view().slice(),
      startTime: f32(currentTime - secondsFromSampleCount(this.#currentSegment.length)),
      endTime: currentTime,
      isComplete: false,
      justUpdated: true,
    });
  }

  #onVoiceContinuing(): void {
    const segment = this.#segments[this.#segments.length - 1] as VoiceActivitySegment;
    segment.audioData = this.#currentSegment.view().slice();
    segment.endTime = secondsFromSampleCount(this.#samplesProcessedCount);
    segment.isComplete = false;
    segment.justUpdated = true;
  }

  #onVoiceEnd(): void {
    const segment = this.#segments[this.#segments.length - 1] as VoiceActivitySegment;
    segment.audioData = this.#currentSegment.view().slice();
    segment.endTime = secondsFromSampleCount(this.#samplesProcessedCount);
    segment.isComplete = true;
    segment.justUpdated = true;
  }
}
