// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Kokoro-82M inference: the parts of Python's `kokoro-onnx` (0.6.1) that
 * Pipecat's `KokoroTTSService` uses, on `@pipedog/onnx` and `@pipedog/espeak-ng`.
 *
 * Same model and voice files as kokoro-onnx (`kokoro-v1.0.onnx` or its int8 /
 * fp16 variants, and `voices-v1.0.bin`), and the same pipeline:
 *
 * 1. Text to phonemes with espeak-ng through `phonemizer`'s algorithm
 *    (punctuation kept, stress marks kept), dropping anything not in the
 *    model's vocabulary.
 * 2. Phonemes split into batches of at most 510 (`MAX_PHONEME_LENGTH`),
 *    preferring sentence, then clause, then word boundaries, balanced in size.
 * 3. Each batch: token ids padded with 0 at both ends, the voice's style
 *    vector for that token count (row `n - 1`), and the speed.
 * 4. Each batch's audio has its leading and trailing silence trimmed (librosa
 *    `trim`, 60 dB), then 0.25 s of silence after a sentence mark or 0.1 s
 *    after a clause mark, except after the last batch.
 *
 * Audio is float32 mono at 24 kHz.
 *
 * Not ported: timed synthesis (`create_timed`, `continuous`), which needs a
 * model re-exported with a duration output, and reading a vocabulary embedded
 * in the model's metadata (`@pipedog/onnx` does not expose it; pass `vocab`).
 *
 * @example
 * ```ts
 * const kokoro = await Kokoro.load("kokoro-v1.0.onnx", "voices-v1.0.bin");
 * for await (const [samples, sampleRate] of kokoro.createStream("Hello!", { voice: "af_heart" })) {
 *   // samples: Float32Array at 24000 Hz
 * }
 * ```
 */

import { logger } from "@pipedog/core/utils/logger";
import { type EspeakNG, getEspeakNG, phonemizeWith } from "@pipedog/espeak-ng";
import {
  createOnnxBackend,
  fileExists,
  float32Tensor,
  int32Tensor,
  int64Tensor,
  loadModelBytes,
  type OnnxBackend,
  type OnnxModelSource,
  type OnnxSession,
  type OnnxSessionOptions,
  type OnnxTensor,
  sharedSession,
} from "@pipedog/onnx";
import { type NpyArray, parseNpz } from "./npz.ts";
import { trim as trimAudio } from "./trim.ts";

/** The model context, in phonemes. */
export const MAX_PHONEME_LENGTH = 510;
/** Output sample rate. */
export const SAMPLE_RATE = 24000;

/** kokoro-onnx's `config.json` vocabulary: phoneme to token id. */
export const DEFAULT_VOCAB: Readonly<Record<string, number>> = {
  ";": 1,
  ":": 2,
  ",": 3,
  ".": 4,
  "!": 5,
  "?": 6,
  "—": 9,
  "…": 10,
  '"': 11,
  "(": 12,
  ")": 13,
  "“": 14,
  "”": 15,
  " ": 16,
  "̃": 17,
  ʣ: 18,
  ʥ: 19,
  ʦ: 20,
  ʨ: 21,
  ᵝ: 22,
  ꭧ: 23,
  A: 24,
  I: 25,
  O: 31,
  Q: 33,
  S: 35,
  T: 36,
  W: 39,
  Y: 41,
  ᵊ: 42,
  a: 43,
  b: 44,
  c: 45,
  d: 46,
  e: 47,
  f: 48,
  h: 50,
  i: 51,
  j: 52,
  k: 53,
  l: 54,
  m: 55,
  n: 56,
  o: 57,
  p: 58,
  q: 59,
  r: 60,
  s: 61,
  t: 62,
  u: 63,
  v: 64,
  w: 65,
  x: 66,
  y: 67,
  z: 68,
  ɑ: 69,
  ɐ: 70,
  ɒ: 71,
  æ: 72,
  β: 75,
  ɔ: 76,
  ɕ: 77,
  ç: 78,
  ɖ: 80,
  ð: 81,
  ʤ: 82,
  ə: 83,
  ɚ: 85,
  ɛ: 86,
  ɜ: 87,
  ɟ: 90,
  ɡ: 92,
  ɥ: 99,
  ɨ: 101,
  ɪ: 102,
  ʝ: 103,
  ɯ: 110,
  ɰ: 111,
  ŋ: 112,
  ɳ: 113,
  ɲ: 114,
  ɴ: 115,
  ø: 116,
  ɸ: 118,
  θ: 119,
  œ: 120,
  ɹ: 123,
  ɾ: 125,
  ɻ: 126,
  ʁ: 128,
  ɽ: 129,
  ʂ: 130,
  ʃ: 131,
  ʈ: 132,
  ʧ: 133,
  ʊ: 135,
  ʋ: 136,
  ʌ: 138,
  ɣ: 139,
  ɤ: 140,
  χ: 142,
  ʎ: 143,
  ʒ: 147,
  ʔ: 148,
  ˈ: 156,
  ˌ: 157,
  ː: 158,
  ʰ: 162,
  ʲ: 164,
  "↓": 169,
  "→": 171,
  "↗": 172,
  "↘": 173,
  ᵻ: 177,
};

// ---------------------------------------------------------------------------
// tokenizer.py

export interface TokenizerOptions {
  /** Phoneme to token id (default `DEFAULT_VOCAB`). */
  vocab?: Readonly<Record<string, number>> | null;
  /** The eSpeak NG instance (default: the shared one). */
  espeak?: EspeakNG | Promise<EspeakNG> | null;
}

/** Phonemizes text and maps phonemes to token ids. */
export class Tokenizer {
  readonly vocab: Readonly<Record<string, number>>;
  readonly #espeak: EspeakNG | Promise<EspeakNG> | null;

  constructor(options: TokenizerOptions = {}) {
    this.vocab =
      options.vocab && Object.keys(options.vocab).length > 0 ? options.vocab : DEFAULT_VOCAB;
    this.#espeak = options.espeak ?? null;
  }

  static normalizeText(text: string): string {
    return text.trim();
  }

  /** Map phonemes to token ids, dropping anything outside the vocabulary. */
  tokenize(phonemes: string, limit: number | null = MAX_PHONEME_LENGTH): number[] {
    const chars = Array.from(phonemes);
    if (limit !== null && chars.length > limit) {
      throw new Error(`text is too long, must be less than ${limit} phonemes`);
    }
    const out: number[] = [];
    for (const c of chars) {
      const id = this.vocab[c];
      if (id !== undefined) out.push(id);
    }
    return out;
  }

  /** The phonemes that survive tokenization, aligned one to one with it. */
  known(phonemes: string): string {
    return Array.from(phonemes)
      .filter((p) => p in this.vocab)
      .join("");
  }

  /**
   * Phonemize `text` with espeak-ng (`phonemizer.phonemize(text, lang,
   * preserve_punctuation=True, with_stress=True)`), keeping only phonemes in
   * the vocabulary.
   *
   * @param lang An espeak-ng language code such as `en-us`, `en-gb`, `fr-fr`, `cmn`.
   */
  async phonemize(text: string, lang = "en-us", norm = true): Promise<string> {
    if (norm) text = Tokenizer.normalizeText(text);
    const espeak = await (this.#espeak ?? getEspeakNG());
    const phonemes = phonemizeWith(espeak, text, lang, {
      preservePunctuation: true,
      withStress: true,
    });
    return Array.from(phonemes)
      .filter((p) => p in this.vocab)
      .join("")
      .trim();
  }
}

// ---------------------------------------------------------------------------
// chunker.py

export const SENTENCE_MARKS = ".!?…";
export const CLAUSE_MARKS = ",;:";

// Least to most disruptive place to cut. Punctuation stays with the text
// before it, which is how the model was trained.
const BOUNDARIES = [/(?<=[.!?…])\s+/u, /(?<=[,;:])\s+/u, /\s+/u];

function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Pieces of `phonemes`, each no longer than `maxLength`. */
function* atoms(phonemes: string, maxLength: number, level = 0): Generator<string> {
  if (cpLength(phonemes) <= maxLength) {
    if (phonemes) yield phonemes;
    return;
  }
  for (let index = level; index < BOUNDARIES.length; index++) {
    const pieces = phonemes.split(BOUNDARIES[index] as RegExp);
    if (pieces.length > 1) {
      for (const piece of pieces) yield* atoms(piece.trim(), maxLength, index + 1);
      return;
    }
  }
  // A single unbroken run longer than the context: slice it rather than
  // dropping the tail.
  const chars = Array.from(phonemes);
  for (let start = 0; start < chars.length; start += maxLength) {
    yield chars.slice(start, start + maxLength).join("");
  }
}

/** Group consecutive atoms into batches within `limit`, as index ranges. */
function pack(lengths: number[], limit: number): [number, number][] {
  const batches: [number, number][] = [];
  let start = 0;
  let size = 0;
  lengths.forEach((length, index) => {
    const candidate = index === start ? length : size + 1 + length;
    if (candidate > limit && index > start) {
      batches.push([start, index]);
      start = index;
      size = length;
    } else {
      size = candidate;
    }
  });
  if (lengths.length > 0) batches.push([start, lengths.length]);
  return batches;
}

/**
 * Split `phonemes` into evenly sized batches of at most `maxLength`.
 *
 * Filling each batch to the limit would leave a short remainder, and a short
 * batch is spoken at a different rate and loudness than its neighbours. The
 * batches are therefore balanced: the smallest limit that still needs no
 * extra pass over the text.
 */
export function splitPhonemes(phonemes: string, maxLength = MAX_PHONEME_LENGTH): string[] {
  const parts = [...atoms(phonemes.trim(), maxLength)];
  if (parts.length === 0) return [];

  const lengths = parts.map(cpLength);
  const fewest = pack(lengths, maxLength).length;

  let low = Math.max(...lengths);
  let high = maxLength;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (pack(lengths, middle).length <= fewest) high = middle;
    else low = middle + 1;
  }
  return pack(lengths, low).map(([start, end]) => parts.slice(start, end).join(" "));
}

/** Seconds of silence a batch ending with this text should be followed by. */
export function pauseAfter(phonemes: string, sentence: number, clause: number): number {
  const chars = Array.from(phonemes.trimEnd());
  const mark = chars[chars.length - 1] ?? "";
  if (mark && SENTENCE_MARKS.includes(mark)) return sentence;
  if (mark && CLAUSE_MARKS.includes(mark)) return clause;
  return 0.0;
}

// ---------------------------------------------------------------------------
// Voices

/** A voice: one style vector per phoneme count (shape `[510, 1, 256]`). */
export type VoiceStyle = NpyArray;

/** Voices shared by path, so services in one process load the file once. */
const sharedVoices = new Map<string, Promise<Map<string, VoiceStyle>>>();

/** Read a voices file (`voices-v1.0.bin`, a NumPy `.npz`). */
export async function loadVoices(source: OnnxModelSource): Promise<Map<string, VoiceStyle>> {
  if (typeof source === "string" && !source.includes("://") && !(await fileExists(source))) {
    throw new Error(
      `Voices file not found at ${source}\n` +
        "You can download the voices file using the following command:\n" +
        "wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
    );
  }
  return parseNpz(await loadModelBytes(source));
}

function loadSharedVoices(source: OnnxModelSource): Promise<Map<string, VoiceStyle>> {
  if (typeof source !== "string" && !(source instanceof URL)) return loadVoices(source);
  const key = source instanceof URL ? source.href : source;
  let entry = sharedVoices.get(key);
  if (!entry) {
    entry = loadVoices(source);
    sharedVoices.set(key, entry);
    entry.catch(() => sharedVoices.delete(key));
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Kokoro

/** Element types the model inputs can take (they differ between exports). */
export interface KokoroInputTypes {
  /** Token ids input (default `int64`). */
  tokens?: "int64" | "int32";
  /** Speed input: `float32` for v1.0 (default), an integer type for v1.1-zh. */
  speed?: "float32" | "int64" | "int32";
}

export interface KokoroOptions {
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend> | null;
  /**
   * Share the inference session (and the voices file) with other `Kokoro`
   * instances for the same files (default `true`). The model is stateless.
   */
  shareSession?: boolean;
  /** Session options passed to the backend. */
  sessionOptions?: OnnxSessionOptions;
  /**
   * The vocabulary: phoneme to id, or a parsed `config.json` (`{ vocab }`).
   * Default: kokoro-onnx's.
   */
  vocab?: Readonly<Record<string, number>> | { vocab: Readonly<Record<string, number>> } | null;
  /** The eSpeak NG instance (default: the shared one). */
  espeak?: EspeakNG | Promise<EspeakNG> | null;
  /**
   * Input element types. kokoro-onnx reads them from the model; the
   * `@pipedog/onnx` session interface does not expose them, so the v1.0
   * types are assumed unless given.
   */
  inputTypes?: KokoroInputTypes;
}

export interface CreateStreamOptions {
  /** A voice name from the voices file, or a style array of the same shape. */
  voice: string | VoiceStyle;
  /** Speed, 0.5 to 2.0 (default 1.0). */
  speed?: number;
  /** espeak-ng language code (default `en-us`). */
  lang?: string;
  /** `text` is phonemes already (default `false`). */
  isPhonemes?: boolean;
  /** Trim the silence around each batch (default `true`). */
  trim?: boolean;
  /** Seconds of silence after a batch ending a sentence (default 0.25). */
  sentencePause?: number;
  /** Seconds of silence after a batch ending a clause (default 0.1). */
  clausePause?: number;
}

function vocabOf(vocab: KokoroOptions["vocab"]): Readonly<Record<string, number>> | null {
  if (!vocab) return null;
  if (typeof (vocab as { vocab?: unknown }).vocab === "object") {
    return (vocab as { vocab: Readonly<Record<string, number>> }).vocab;
  }
  return vocab as Readonly<Record<string, number>>;
}

function quote(text: string): string {
  return `'${text}'`;
}

/** Kokoro-82M text-to-speech (kokoro-onnx's `Kokoro`). */
export class Kokoro {
  /** The voices file's voices, by name. */
  readonly voices: ReadonlyMap<string, VoiceStyle>;
  readonly tokenizer: Tokenizer;
  readonly sess: OnnxSession;
  readonly #tokensInput: string;
  readonly #inputTypes: Required<KokoroInputTypes>;

  /**
   * Load the model and voices.
   *
   * @param modelPath The ONNX model: a path, a URL or its bytes.
   * @param voicesPath The voices file (`voices-v1.0.bin`): a path, a URL or its bytes.
   */
  static async load(
    modelPath: OnnxModelSource,
    voicesPath: OnnxModelSource,
    options: KokoroOptions = {},
  ): Promise<Kokoro> {
    if (
      typeof modelPath === "string" &&
      !modelPath.includes("://") &&
      !(await fileExists(modelPath))
    ) {
      throw new Error(
        `Model file not found at ${modelPath}\n` +
          "You can download the model file from https://github.com/thewh1teagle/kokoro-onnx/releases",
      );
    }
    const voices = await (options.shareSession === false
      ? loadVoices(voicesPath)
      : loadSharedVoices(voicesPath));
    const backend = await (options.backend ?? createOnnxBackend());
    const sessionOptions = options.sessionOptions ?? {};
    const session =
      options.shareSession === false
        ? await backend.createSession(modelPath, sessionOptions)
        : await sharedSession(backend, modelPath, sessionOptions);
    return new Kokoro(session, voices, options);
  }

  /** Use an existing session (kokoro-onnx's `Kokoro.from_session`). */
  static async fromSession(
    session: OnnxSession,
    voicesPath: OnnxModelSource,
    options: KokoroOptions = {},
  ): Promise<Kokoro> {
    return new Kokoro(session, await loadVoices(voicesPath), options);
  }

  constructor(
    session: OnnxSession,
    voices: ReadonlyMap<string, VoiceStyle>,
    options: KokoroOptions = {},
  ) {
    this.sess = session;
    this.voices = voices;
    this.tokenizer = new Tokenizer({ vocab: vocabOf(options.vocab), espeak: options.espeak });
    // Older exports name the token input "tokens", newer ones "input_ids".
    this.#tokensInput = session.inputNames.includes("input_ids") ? "input_ids" : "tokens";
    this.#inputTypes = {
      tokens: options.inputTypes?.tokens ?? "int64",
      speed: options.inputTypes?.speed ?? "float32",
    };
  }

  /** Voice names, sorted. */
  getVoices(): string[] {
    return [...this.voices.keys()].sort();
  }

  getVoiceStyle(name: string): VoiceStyle {
    const voice = this.voices.get(name);
    if (!voice) throw new Error(`Voice ${name} not found in available voices`);
    return voice;
  }

  /** Adapt the requested speed to what the graph accepts. */
  #speedValue(speed: number): number {
    if (this.#inputTypes.speed !== "float32" && speed !== Math.trunc(speed)) {
      const rounded = Math.max(1, Math.round(speed));
      logger.warning(
        `This model was exported with an integer speed input, rounding speed ${speed} to ${rounded}`,
      );
      return rounded;
    }
    return speed;
  }

  /** Run the model on one window of tokens. */
  async #infer(
    tokens: number[],
    style: Float32Array,
    styleDims: number[],
    speed: number,
  ): Promise<Float32Array> {
    const ids = [0, ...tokens, 0];
    const tokensTensor: OnnxTensor =
      this.#inputTypes.tokens === "int32"
        ? int32Tensor(Int32Array.from(ids), [1, ids.length])
        : int64Tensor(BigInt64Array.from(ids, BigInt), [1, ids.length]);
    const value = this.#speedValue(speed);
    let speedTensor: OnnxTensor;
    if (this.#inputTypes.speed === "int64")
      speedTensor = int64Tensor(BigInt64Array.of(BigInt(value)), [1]);
    else if (this.#inputTypes.speed === "int32")
      speedTensor = int32Tensor(Int32Array.of(value), [1]);
    else speedTensor = float32Tensor(Float32Array.of(value), [1]);

    const start = performance.now();
    const outputs = await this.sess.run({
      [this.#tokensInput]: tokensTensor,
      style: float32Tensor(style, styleDims),
      speed: speedTensor,
    });
    const audio = outputs[this.sess.outputNames[0] as string]?.data as Float32Array;
    const audioDuration = audio.length / SAMPLE_RATE;
    const createDuration = (performance.now() - start) / 1000;
    logger.debug(
      `Created audio in length of ${audioDuration.toFixed(2)}s for ${tokens.length} phonemes in ${createDuration.toFixed(2)}s (RTF: ${(createDuration / audioDuration).toFixed(2)}`,
    );
    return audio;
  }

  /** One style vector per phoneme count, so n phonemes use row n - 1. */
  #styleFor(voice: VoiceStyle, length: number): [Float32Array, number[]] {
    const rows = voice.shape[0] as number;
    const rowDims = voice.shape.slice(1);
    const rowSize = rowDims.reduce((a, b) => a * b, 1);
    const row = Math.min(length, rows) - 1;
    return [voice.data.subarray(row * rowSize, (row + 1) * rowSize), rowDims];
  }

  /** Resolve the voice style and split the text into batches and pauses. */
  async #prepare(
    text: string,
    options: CreateStreamOptions,
  ): Promise<[VoiceStyle, string, [string, number][]]> {
    const speed = options.speed ?? 1.0;
    if (!(speed >= 0.5 && speed <= 2.0)) {
      throw new Error(`Speed should be between 0.5 and 2.0, got ${speed}`);
    }
    const voice =
      typeof options.voice === "string" ? this.getVoiceStyle(options.voice) : options.voice;

    let phonemes = options.isPhonemes
      ? text
      : await this.tokenizer.phonemize(text, options.lang ?? "en-us");
    // Newlines are not in the vocabulary, so without this the lines of a
    // text run together with no gap for the model to pause on.
    phonemes = phonemes.split(/\s+/u).filter(Boolean).join(" ");
    const batched = splitPhonemes(phonemes, MAX_PHONEME_LENGTH);
    if (batched.length === 0) {
      throw new Error(`Nothing to synthesize, ${quote(text)} produced no phonemes`);
    }
    logger.debug(`Creating audio for ${batched.length} batches for ${cpLength(phonemes)} phonemes`);
    // Trimming removes the silence the model puts at a batch end, so the
    // pause the punctuation calls for is added back when joining.
    const sentencePause = options.sentencePause ?? 0.25;
    const clausePause = options.clausePause ?? 0.1;
    const batches: [string, number][] = batched
      .slice(0, -1)
      .map((batch) => [batch, pauseAfter(batch, sentencePause, clausePause)]);
    batches.push([batched[batched.length - 1] as string, 0.0]);
    return [voice, phonemes, batches];
  }

  /** Synthesize one batch, trimming silence and pausing after when trimming. */
  async #createBatch(
    phonemes: string,
    voice: VoiceStyle,
    speed: number,
    trim: boolean,
    pause: number,
  ): Promise<Float32Array> {
    const tokens = this.tokenizer.tokenize(phonemes);
    if (tokens.length === 0) {
      throw new Error(`No phonemes of ${quote(phonemes)} are in the model vocabulary`);
    }
    const [style, dims] = this.#styleFor(voice, tokens.length);
    let audio = await this.#infer(tokens, style, dims, speed);
    if (trim) {
      // Trim leading and trailing silence for a more natural sound concatenation.
      [audio] = trimAudio(audio);
      if (pause) {
        const out = new Float32Array(audio.length + Math.trunc(pause * SAMPLE_RATE));
        out.set(audio);
        audio = out;
      }
    }
    return audio;
  }

  /**
   * Stream the audio, one batch at a time, as `[samples, sampleRate]`.
   *
   * The next batch is synthesized while the current one is consumed.
   * Abandoning the generator stops the stream; the batch already running
   * finishes, no further batch is started.
   */
  async *createStream(
    text: string,
    options: CreateStreamOptions,
  ): AsyncGenerator<[Float32Array, number], void, undefined> {
    const speed = options.speed ?? 1.0;
    const [voice, , batches] = await this.#prepare(text, options);
    const trim = options.trim ?? true;
    const run = (i: number) => {
      const [phonemes, pause] = batches[i] as [string, number];
      const p = this.#createBatch(phonemes, voice, speed, trim, pause);
      // Handled by the consumer if it gets there; never an unhandled rejection.
      p.catch(() => {});
      return p;
    };
    let next: Promise<Float32Array> | null = run(0);
    for (let i = 0; i < batches.length; i++) {
      const audio: Float32Array = await (next as Promise<Float32Array>);
      next = i + 1 < batches.length ? run(i + 1) : null;
      logger.debug(`Processed chunk ${i} of stream`);
      yield [audio, SAMPLE_RATE];
    }
  }

  /** Synthesize the whole text: `[samples, sampleRate]`. */
  async create(text: string, options: CreateStreamOptions): Promise<[Float32Array, number]> {
    const parts: Float32Array[] = [];
    for await (const [audio] of this.createStream(text, options)) parts.push(audio);
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return [out, SAMPLE_RATE];
  }
}
