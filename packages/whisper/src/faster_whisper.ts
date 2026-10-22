// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Portions derived from faster-whisper (https://github.com/SYSTRAN/faster-whisper,
// faster_whisper/transcribe.py, tokenizer.py, feature_extractor.py, audio.py):
//
//   Copyright (c) 2023 SYSTRAN. Licensed under the MIT License.
//
// and from the decoding rules of CTranslate2's Whisper model and OpenAI Whisper
// (MIT License).

/**
 * faster-whisper's `WhisperModel` on ONNX Runtime.
 *
 * Pipecat's `WhisperSTTService` runs Whisper with faster-whisper (CTranslate2).
 * Neither has a JavaScript build, so this module re-implements the part of
 * faster-whisper's API the service uses, with the same decoding algorithm, on
 * `@pipedog/onnx` and the Hugging Face ONNX exports of the same Whisper
 * checkpoints (`onnx-community/whisper-*`, `distil-whisper/*`):
 *
 * ```ts
 * const model = new WhisperModel("tiny", { device: "cpu", computeType: "int8" });
 * const [segments, info] = await model.transcribe(audio, { language: "en" });
 * for await (const segment of segments) console.log(segment.text, segment.noSpeechProb);
 * ```
 *
 * What is the same as faster-whisper:
 * - log-mel features (80 or 128 bins, from the repo's `preprocessor_config.json`),
 *   computed over the whole input and cut into 30 s windows as faster-whisper does;
 * - the prompt: `<|startofprev|>` + hotwords + previous text, the SOT sequence
 *   (`<|startoftranscript|><|lang|><|task|>`), `<|notimestamps|>` or timestamp
 *   mode, and the prefix;
 * - `noSpeechProb`: the softmax probability of `<|nospeech|>` (`<|nocaptions|>`
 *   on older tokenizers) at the `<|startoftranscript|>` position;
 * - `suppress_tokens` (`-1` = faster-whisper's non-speech symbol set),
 *   `suppress_blank`, the timestamp rules (pairs, monotonic, forced initial
 *   timestamp with `max_initial_timestamp`, timestamp-vs-text probability rule);
 * - beam search (default `beamSize` 5, `patience`, `lengthPenalty`) at
 *   temperature 0, best-of-N sampling above it, and the temperature fallback on
 *   compression ratio / average log probability, with the no-speech skip;
 * - segment splitting on timestamp tokens, `condition_on_previous_text` and
 *   `prompt_reset_on_temperature` across 30 s windows;
 * - language detection on the first window when `language` is not given.
 *
 * What is not implemented: `vad_filter`, `word_timestamps`,
 * `hallucination_silence_threshold`, `clip_timestamps`, per-window
 * `multilingual` detection, `repetition_penalty` and `no_repeat_ngram_size`
 * other than their defaults, and the batched pipeline. Passing them throws.
 *
 * The decoder runs with a KV cache (`decoder_model_merged`, `use_cache_branch`);
 * beam search runs the beams as one batch, as CTranslate2 does.
 */

import { Tokenizer as HFTokenizer } from "@huggingface/tokenizers";
import { rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import {
  boolTensor,
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
  sharedSession,
} from "@pipedog/onnx";

// ---------------------------------------------------------------------------
// Languages and models

/** The language codes faster-whisper accepts (`faster_whisper.tokenizer._LANGUAGE_CODES`). */
// biome-ignore format: one row per 15 codes
export const LANGUAGE_CODES: readonly string[] = [
  "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "ca", "cs", "cy",
  "da", "de", "el", "en", "es", "et", "eu", "fa", "fi", "fo", "fr", "gl", "gu", "ha", "haw",
  "he", "hi", "hr", "ht", "hu", "hy", "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn",
  "ko", "la", "lb", "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt",
  "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru", "sa", "sd", "si",
  "sk", "sl", "sn", "so", "sq", "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl",
  "tr", "tt", "uk", "ur", "uz", "vi", "yi", "yo", "zh", "yue",
];

const TASKS = ["transcribe", "translate"] as const;

/**
 * faster-whisper's model names (`faster_whisper.utils._MODELS`), mapped to the
 * Hugging Face repos holding ONNX exports of the same checkpoints.
 *
 * faster-whisper downloads CTranslate2 conversions (`Systran/faster-whisper-*`);
 * these are the ONNX conversions (Optimum / transformers.js layout:
 * `onnx/encoder_model*.onnx`, `onnx/decoder_model_merged*.onnx` plus the
 * tokenizer and configs at the repo root).
 */
export const ONNX_WHISPER_MODELS: Readonly<Record<string, string>> = {
  "tiny.en": "onnx-community/whisper-tiny.en",
  tiny: "onnx-community/whisper-tiny",
  "base.en": "onnx-community/whisper-base.en",
  base: "onnx-community/whisper-base",
  "small.en": "onnx-community/whisper-small.en",
  small: "onnx-community/whisper-small",
  "medium.en": "Xenova/whisper-medium.en",
  medium: "onnx-community/whisper-medium-ONNX",
  "large-v1": "Xenova/whisper-large",
  "large-v2": "onnx-community/whisper-large-v2-ONNX",
  "large-v3": "onnx-community/whisper-large-v3-ONNX",
  large: "onnx-community/whisper-large-v3-ONNX",
  "distil-large-v2": "distil-whisper/distil-large-v2",
  "distil-medium.en": "distil-whisper/distil-medium.en",
  "distil-small.en": "distil-whisper/distil-small.en",
  "distil-large-v3": "distil-whisper/distil-large-v3",
  "distil-large-v3.5": "distil-whisper/distil-large-v3.5-ONNX",
  "large-v3-turbo": "onnx-community/whisper-large-v3-turbo",
  turbo: "onnx-community/whisper-large-v3-turbo",
};

/**
 * CTranslate2 repo ids (as faster-whisper and Pipecat's `Model` enum name them)
 * mapped to faster-whisper model names, so they resolve to the same ONNX repos.
 */
export const CT2_REPO_ALIASES: Readonly<Record<string, string>> = {
  "Systran/faster-whisper-tiny.en": "tiny.en",
  "Systran/faster-whisper-tiny": "tiny",
  "Systran/faster-whisper-base.en": "base.en",
  "Systran/faster-whisper-base": "base",
  "Systran/faster-whisper-small.en": "small.en",
  "Systran/faster-whisper-small": "small",
  "Systran/faster-whisper-medium.en": "medium.en",
  "Systran/faster-whisper-medium": "medium",
  "Systran/faster-whisper-large-v1": "large-v1",
  "Systran/faster-whisper-large-v2": "large-v2",
  "Systran/faster-whisper-large-v3": "large-v3",
  "Systran/faster-distil-whisper-large-v2": "distil-large-v2",
  "Systran/faster-distil-whisper-medium.en": "distil-medium.en",
  "Systran/faster-distil-whisper-small.en": "distil-small.en",
  "Systran/faster-distil-whisper-large-v3": "distil-large-v3",
  "distil-whisper/distil-large-v3.5-ct2": "distil-large-v3.5",
  "deepdml/faster-whisper-large-v3-turbo-ct2": "large-v3-turbo",
  "mobiuslabsgmbh/faster-whisper-large-v3-turbo": "large-v3-turbo",
};

/** Names faster-whisper accepts (`faster_whisper.utils.available_models()`). */
export function availableModels(): string[] {
  return Object.keys(ONNX_WHISPER_MODELS);
}

/**
 * ONNX weight variants, by the transformers.js `dtype` names.
 *
 * - `fp32`: full precision (`*.onnx`; the large models keep their weights in
 *   a `*.onnx_data` file next to it).
 * - `q8`: dynamic int8 quantization (`*_quantized.onnx`), available in every repo.
 * - `int8`, `uint8`: int8 / uint8 quantization (`*_int8.onnx`, `*_uint8.onnx`).
 * - `q4`, `bnb4`: 4-bit weights (`*_q4.onnx`, `*_bnb4.onnx`).
 *
 * Not every repo has every variant: the `distil-whisper/*` exports (except
 * distil-large-v3.5) and `Xenova/whisper-large` only have `fp32` and `q8`.
 * The fp16 variants are not supported: their inputs and outputs are float16
 * tensors, which `@pipedog/onnx` doesn't carry.
 */
export type WhisperDtype = "fp32" | "q8" | "int8" | "uint8" | "q4" | "bnb4";

const DTYPE_SUFFIX: Record<WhisperDtype, string> = {
  fp32: "",
  q8: "_quantized",
  int8: "_int8",
  uint8: "_uint8",
  q4: "_q4",
  bnb4: "_bnb4",
};

/** The encoder and decoder weight variants to load. */
export interface WhisperDtypes {
  encoder: WhisperDtype;
  decoder: WhisperDtype;
}

/** The default variants: full-precision encoder, int8 decoder. */
export const DEFAULT_DTYPES: Readonly<WhisperDtypes> = { encoder: "fp32", decoder: "q8" };

/**
 * Map a faster-whisper `compute_type` (or an ONNX dtype name) to the ONNX
 * weight variants.
 *
 * - `default` / `auto`: `DEFAULT_DTYPES` (fp32 encoder, q8 decoder).
 * - `int8`, `int8_float32`, `int8_float16`, `int8_bfloat16`: `q8` for both.
 * - `float32`: `fp32` for both.
 * - `float16`, `bfloat16`, `int16`: no ONNX equivalent here; `fp32` with a warning
 *   (CTranslate2 also falls back when a type isn't supported on the device).
 * - an ONNX dtype name (`fp32`, `q8`, `int8`, `uint8`, `q4`, `bnb4`): that, for both.
 */
export function computeTypeToDtypes(computeType: string): WhisperDtypes {
  switch (computeType) {
    case "default":
    case "auto":
      return { ...DEFAULT_DTYPES };
    case "int8":
    case "int8_float32":
    case "int8_float16":
    case "int8_bfloat16":
      return { encoder: "q8", decoder: "q8" };
    case "float32":
      return { encoder: "fp32", decoder: "fp32" };
    case "float16":
    case "bfloat16":
    case "int16":
      logger.warning(
        `Whisper (ONNX): compute type '${computeType}' is not available; using float32 instead.`,
      );
      return { encoder: "fp32", decoder: "fp32" };
    default:
      if (computeType in DTYPE_SUFFIX) {
        const dtype = computeType as WhisperDtype;
        return { encoder: dtype, decoder: dtype };
      }
      throw new Error(
        `Unsupported compute type '${computeType}' (accepted: default, auto, int8, int8_float32, ` +
          `int8_float16, int8_bfloat16, float32, float16, bfloat16, int16, ${Object.keys(DTYPE_SUFFIX).join(", ")})`,
      );
  }
}

// ---------------------------------------------------------------------------
// Feature extraction (faster_whisper/feature_extractor.py)

/** Factor `n` into the radices the FFT handles (2, 3, 4, 5, then any prime). */
function fftFactors(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  for (const p of [4, 2, 3, 5]) {
    while (rest % p === 0) {
      out.push(p);
      rest /= p;
    }
  }
  for (let p = 7; rest > 1; p += 2) {
    while (rest % p === 0) {
      out.push(p);
      rest /= p;
    }
  }
  return out;
}

/** A mixed-radix complex FFT of fixed size (`n_fft` is 400 = 4·4·5·5). */
class Fft {
  readonly n: number;
  readonly #factors: number[];
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;
  readonly #tmpRe: Float64Array;
  readonly #tmpIm: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.#factors = fftFactors(n);
    this.#cos = new Float64Array(n);
    this.#sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.#cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.#sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const maxP = Math.max(1, ...this.#factors);
    this.#tmpRe = new Float64Array(maxP);
    this.#tmpIm = new Float64Array(maxP);
  }

  /** Forward FFT of a real signal; writes all `n` bins to `outRe` / `outIm`. */
  forwardReal(input: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
    this.#rec(input, 0, 1, this.n, outRe, outIm, 0, 0);
  }

  #rec(
    x: Float64Array,
    off: number,
    stride: number,
    n: number,
    oRe: Float64Array,
    oIm: Float64Array,
    oOff: number,
    fi: number,
  ): void {
    if (n === 1) {
      oRe[oOff] = x[off] as number;
      oIm[oOff] = 0;
      return;
    }
    const p = this.#factors[fi] as number;
    const m = n / p;
    for (let q = 0; q < p; q++) {
      this.#rec(x, off + q * stride, stride * p, m, oRe, oIm, oOff + q * m, fi + 1);
    }
    // X[k + j·m] = Σ_q Y_q[k] · W_n^{q·(k + j·m)}, with W_n = e^{-2πi/n}.
    const tw = this.n / n;
    const tRe = this.#tmpRe;
    const tIm = this.#tmpIm;
    const cos = this.#cos;
    const sin = this.#sin;
    for (let k = 0; k < m; k++) {
      for (let q = 0; q < p; q++) {
        tRe[q] = oRe[oOff + q * m + k] as number;
        tIm[q] = oIm[oOff + q * m + k] as number;
      }
      for (let j = 0; j < p; j++) {
        const kk = k + j * m;
        let sumRe = 0;
        let sumIm = 0;
        for (let q = 0; q < p; q++) {
          const idx = ((q * kk) % n) * tw;
          const c = cos[idx] as number;
          const s = sin[idx] as number;
          const yr = tRe[q] as number;
          const yi = tIm[q] as number;
          sumRe += yr * c + yi * s;
          sumIm += yi * c - yr * s;
        }
        oRe[oOff + kk] = sumRe;
        oIm[oOff + kk] = sumIm;
      }
    }
  }
}

/** numpy `mode="reflect"` index (the edge sample is not repeated). */
function reflectIndex(i: number, length: number): number {
  if (length === 1) return 0;
  const period = 2 * (length - 1);
  let j = i % period;
  if (j < 0) j += period;
  return j < length ? j : period - j;
}

/** Log-mel features: `data` is a row-major `(nMels, nFrames)` matrix. */
export interface WhisperFeatures {
  data: Float32Array;
  nMels: number;
  nFrames: number;
}

/** Options of `FeatureExtractor` (faster-whisper's names, camelCased). */
export interface FeatureExtractorOptions {
  featureSize?: number;
  samplingRate?: number;
  hopLength?: number;
  chunkLength?: number;
  nFft?: number;
}

/** faster-whisper's `FeatureExtractor`: Whisper log-mel spectrograms without numpy. */
export class FeatureExtractor {
  readonly nFft: number;
  readonly hopLength: number;
  chunkLength: number;
  nSamples: number;
  nbMaxFrames: number;
  readonly timePerFrame: number;
  readonly samplingRate: number;
  readonly featureSize: number;
  /** Row-major `(featureSize, nFft/2 + 1)` mel filterbank. */
  readonly melFilters: Float32Array;
  readonly #filterRanges: Array<[number, number]>;
  readonly #fft: Fft;
  readonly #window: Float64Array;

  constructor(options: FeatureExtractorOptions = {}) {
    this.featureSize = options.featureSize ?? 80;
    this.samplingRate = options.samplingRate ?? 16000;
    this.hopLength = options.hopLength ?? 160;
    this.chunkLength = options.chunkLength ?? 30;
    this.nFft = options.nFft ?? 400;
    this.nSamples = this.chunkLength * this.samplingRate;
    this.nbMaxFrames = Math.floor(this.nSamples / this.hopLength);
    this.timePerFrame = this.hopLength / this.samplingRate;
    this.melFilters = FeatureExtractor.getMelFilters(
      this.samplingRate,
      this.nFft,
      this.featureSize,
    );
    const nBins = Math.floor(this.nFft / 2) + 1;
    this.#filterRanges = [];
    for (let m = 0; m < this.featureSize; m++) {
      let start = nBins;
      let end = 0;
      for (let k = 0; k < nBins; k++) {
        if ((this.melFilters[m * nBins + k] as number) !== 0) {
          start = Math.min(start, k);
          end = k + 1;
        }
      }
      this.#filterRanges.push([start, Math.max(start, end)]);
    }
    this.#fft = new Fft(this.nFft);
    // np.hanning(n_fft + 1)[:-1], i.e. a periodic Hann window.
    this.#window = new Float64Array(this.nFft);
    for (let i = 0; i < this.nFft; i++) {
      this.#window[i] = Math.fround(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.nFft));
    }
  }

  /** Slaney mel filterbank, as faster-whisper (and librosa) build it. */
  static getMelFilters(sr: number, nFft: number, nMels = 128): Float32Array {
    const nBins = Math.floor(nFft / 2) + 1;
    const fftFreqs = new Float64Array(nBins);
    for (let k = 0; k < nBins; k++) fftFreqs[k] = (k * sr) / nFft;

    const minMel = 0.0;
    const maxMel = 45.245640471924965;
    const mels = new Float64Array(nMels + 2);
    for (let i = 0; i < nMels + 2; i++) mels[i] = minMel + ((maxMel - minMel) * i) / (nMels + 1);

    const fMin = 0.0;
    const fSp = 200.0 / 3;
    const freqs = new Float64Array(nMels + 2);
    const minLogHz = 1000.0;
    const minLogMel = (minLogHz - fMin) / fSp;
    const logstep = Math.log(6.4) / 27.0;
    for (let i = 0; i < nMels + 2; i++) {
      const mel = mels[i] as number;
      freqs[i] =
        mel >= minLogMel ? minLogHz * Math.exp(logstep * (mel - minLogMel)) : fMin + fSp * mel;
    }

    const weights = new Float32Array(nMels * nBins);
    for (let m = 0; m < nMels; m++) {
      const fdiffLower = (freqs[m + 1] as number) - (freqs[m] as number);
      const fdiffUpper = (freqs[m + 2] as number) - (freqs[m + 1] as number);
      const enorm = 2.0 / ((freqs[m + 2] as number) - (freqs[m] as number));
      for (let k = 0; k < nBins; k++) {
        const lower = -((freqs[m] as number) - (fftFreqs[k] as number)) / fdiffLower;
        const upper = ((freqs[m + 2] as number) - (fftFreqs[k] as number)) / fdiffUpper;
        weights[m * nBins + k] = Math.max(0, Math.min(lower, upper)) * enorm;
      }
    }
    return weights;
  }

  /**
   * Compute the log-mel spectrogram of `waveform` (16 kHz mono float samples).
   *
   * Like faster-whisper, the waveform is padded with `padding` zero samples and
   * the features cover the whole input (not one 30 s window); the dynamic
   * range floor (max − 8) is taken over the whole input.
   */
  compute(
    waveform: Float32Array,
    options: { padding?: number; chunkLength?: number | null } = {},
  ): WhisperFeatures {
    const padding = options.padding ?? 160;
    if (options.chunkLength !== undefined && options.chunkLength !== null) {
      this.chunkLength = options.chunkLength;
      this.nSamples = options.chunkLength * this.samplingRate;
      this.nbMaxFrames = Math.floor(this.nSamples / this.hopLength);
    }
    const length = waveform.length + padding;
    const signal = new Float32Array(length);
    signal.set(waveform);

    const nFft = this.nFft;
    const half = Math.floor(nFft / 2);
    const paddedLength = length + 2 * half;
    if (paddedLength < nFft) {
      throw new Error(`stft: expected 0 < n_fft <= ${paddedLength}, but got n_fft=${nFft}`);
    }
    const stftFrames = 1 + Math.floor((paddedLength - nFft) / this.hopLength);
    const nFrames = stftFrames - 1; // the last STFT frame is dropped
    const nBins = half + 1;
    const nMels = this.featureSize;

    const frame = new Float64Array(nFft);
    const re = new Float64Array(nFft);
    const im = new Float64Array(nFft);
    const power = new Float64Array(nBins);
    const logSpec = new Float64Array(nMels * Math.max(0, nFrames));
    let maxValue = Number.NEGATIVE_INFINITY;
    const window = this.#window;
    const filters = this.melFilters;
    const ranges = this.#filterRanges;

    for (let t = 0; t < nFrames; t++) {
      const start = t * this.hopLength - half;
      for (let i = 0; i < nFft; i++) {
        const idx = start + i;
        const sample =
          idx >= 0 && idx < length
            ? (signal[idx] as number)
            : (signal[reflectIndex(idx, length)] as number);
        frame[i] = sample * (window[i] as number);
      }
      this.#fft.forwardReal(frame, re, im);
      for (let k = 0; k < nBins; k++) {
        // complex64 magnitudes, as faster-whisper casts the STFT.
        const r = Math.fround(re[k] as number);
        const j = Math.fround(im[k] as number);
        power[k] = r * r + j * j;
      }
      for (let m = 0; m < nMels; m++) {
        const [lo, hi] = ranges[m] as [number, number];
        let acc = 0;
        const row = m * nBins;
        for (let k = lo; k < hi; k++) acc += (filters[row + k] as number) * (power[k] as number);
        const value = Math.log10(Math.max(acc, 1e-10));
        logSpec[m * nFrames + t] = value;
        if (value > maxValue) maxValue = value;
      }
    }

    const floor = maxValue - 8.0;
    const data = new Float32Array(logSpec.length);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.max(logSpec[i] as number, floor) + 4.0) / 4.0;
    }
    return { data, nMels, nFrames: Math.max(0, nFrames) };
  }
}

/** Slice frames `[start, start + size)` and zero-pad or trim to `length` (`pad_or_trim`). */
export function padOrTrimFeatures(
  features: WhisperFeatures,
  start: number,
  size: number,
  length = 3000,
): Float32Array {
  const { data, nMels, nFrames } = features;
  const out = new Float32Array(nMels * length);
  const n = Math.max(0, Math.min(size, length, nFrames - start));
  for (let m = 0; m < nMels; m++) {
    out.set(data.subarray(m * nFrames + start, m * nFrames + start + n), m * length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokenizer (faster_whisper/tokenizer.py)

/** The minimal Hugging Face tokenizer surface the Whisper tokenizer needs. */
export interface HfTokenizerLike {
  encode(text: string, options?: { add_special_tokens?: boolean }): { ids: number[] };
  decode(ids: number[], options?: { skip_special_tokens?: boolean }): string;
  token_to_id(token: string): number | undefined;
}

function requireTokenId(tokenizer: HfTokenizerLike, token: string): number {
  const id = tokenizer.token_to_id(token);
  if (id === undefined) throw new Error(`Whisper tokenizer has no ${token} token`);
  return id;
}

/** faster-whisper's `Tokenizer`: Whisper's special tokens over a Hugging Face tokenizer. */
export class Tokenizer {
  readonly tokenizer: HfTokenizerLike;
  task: number | null;
  language: number | null;
  languageCode: string;
  #nonSpeechTokens: number[] | null = null;

  constructor(
    tokenizer: HfTokenizerLike,
    multilingual: boolean,
    options: { task?: string | null; language?: string | null } = {},
  ) {
    this.tokenizer = tokenizer;
    const task = options.task ?? null;
    const language = options.language ?? null;
    if (multilingual) {
      if (!TASKS.includes(task as (typeof TASKS)[number])) {
        throw new Error(`'${task}' is not a valid task (accepted tasks: ${TASKS.join(", ")})`);
      }
      if (language === null || !LANGUAGE_CODES.includes(language)) {
        throw new Error(
          `'${language}' is not a valid language code (accepted language codes: ${LANGUAGE_CODES.join(", ")})`,
        );
      }
      this.task = requireTokenId(tokenizer, `<|${task}|>`);
      this.language = requireTokenId(tokenizer, `<|${language}|>`);
      this.languageCode = language;
    } else {
      this.task = null;
      this.language = null;
      this.languageCode = "en";
    }
  }

  get transcribe(): number {
    return requireTokenId(this.tokenizer, "<|transcribe|>");
  }
  get translate(): number {
    return requireTokenId(this.tokenizer, "<|translate|>");
  }
  get sot(): number {
    return requireTokenId(this.tokenizer, "<|startoftranscript|>");
  }
  get sotLm(): number {
    return requireTokenId(this.tokenizer, "<|startoflm|>");
  }
  get sotPrev(): number {
    return requireTokenId(this.tokenizer, "<|startofprev|>");
  }
  get eot(): number {
    return requireTokenId(this.tokenizer, "<|endoftext|>");
  }
  get noTimestamps(): number {
    return requireTokenId(this.tokenizer, "<|notimestamps|>");
  }
  get noSpeech(): number {
    return (
      this.tokenizer.token_to_id("<|nospeech|>") ?? requireTokenId(this.tokenizer, "<|nocaptions|>")
    );
  }
  get timestampBegin(): number {
    return this.noTimestamps + 1;
  }

  /** `<|startoftranscript|>`, then the language and task tokens (multilingual models). */
  get sotSequence(): number[] {
    const sequence = [this.sot];
    if (this.language !== null) sequence.push(this.language);
    if (this.task !== null) sequence.push(this.task);
    return sequence;
  }

  encode(text: string): number[] {
    return this.tokenizer.encode(text, { add_special_tokens: false }).ids;
  }

  /** Decode the text tokens (those below `<|endoftext|>`). */
  decode(tokens: number[]): string {
    const eot = this.eot;
    const textTokens = tokens.filter((t) => t < eot);
    // tokenizers.js rejects an empty list; Python's tokenizers decodes it to "".
    return textTokens.length === 0 ? "" : this.tokenizer.decode(textTokens);
  }

  /**
   * Tokens to suppress so the model doesn't emit speaker tags or non-speech
   * annotations (`♪♪♪`, `( SPEAKING FOREIGN LANGUAGE )`, `[DAVID] Hey there,`),
   * keeping basic punctuation.
   */
  get nonSpeechTokens(): number[] {
    if (this.#nonSpeechTokens) return this.#nonSpeechTokens;
    const symbols = [...'"#()*+/:;<=>@[\\]^_`{|}~「」『』'];
    symbols.push(
      ..."<< >> <<< >>> -- --- -( -[ (' (\" (( )) ((( ))) [[ ]] {{ }} ♪♪ ♪♪♪".split(" "),
    );
    // Symbols that may be one token or several depending on the tokenizer; if
    // several, suppress the first (U+2640..U+267F share their first two UTF-8 bytes).
    const miscellaneous = new Set([..."♩♪♫♬♭♮♯"]);
    // Allow hyphens "-" and single quotes "'" between words, not at a word's start.
    const result = new Set<number>([
      this.encode(" -")[0] as number,
      this.encode(" '")[0] as number,
    ]);
    for (const symbol of [...symbols, ...miscellaneous]) {
      for (const tokens of [this.encode(symbol), this.encode(` ${symbol}`)]) {
        if (tokens.length === 1 || miscellaneous.has(symbol)) result.add(tokens[0] as number);
      }
    }
    this.#nonSpeechTokens = [...result].sort((a, b) => a - b);
    return this.#nonSpeechTokens;
  }
}

/** faster-whisper's `get_suppressed_tokens`. */
export function getSuppressedTokens(
  tokenizer: Tokenizer,
  suppressTokens: readonly number[] | null,
): number[] {
  let tokens: number[];
  if (suppressTokens?.includes(-1)) {
    tokens = suppressTokens.filter((t) => t >= 0);
    tokens.push(...tokenizer.nonSpeechTokens);
  } else if (suppressTokens === null || suppressTokens.length === 0) {
    tokens = [];
  } else {
    tokens = [...suppressTokens];
  }
  tokens.push(
    tokenizer.transcribe,
    tokenizer.translate,
    tokenizer.sot,
    tokenizer.sotPrev,
    tokenizer.sotLm,
    tokenizer.noSpeech,
  );
  return [...new Set(tokens)].sort((a, b) => a - b);
}

/** `len(text_bytes) / len(zlib.compress(text_bytes))`, with the platform's deflate (zlib format). */
export async function getCompressionRatio(text: string): Promise<number> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) return 0;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  const compressed = await new Response(stream).arrayBuffer();
  return bytes.length / compressed.byteLength;
}

// ---------------------------------------------------------------------------
// Results and options

/** One transcribed segment (faster-whisper's `Segment`). */
export interface Segment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  avgLogprob: number;
  compressionRatio: number;
  noSpeechProb: number;
  /** Word timestamps are not implemented: always null. */
  words: null;
  temperature: number;
}

/** Decoding options (faster-whisper's `TranscriptionOptions`, camelCased). */
export interface TranscriptionOptions {
  beamSize: number;
  bestOf: number;
  patience: number;
  lengthPenalty: number;
  repetitionPenalty: number;
  noRepeatNgramSize: number;
  logProbThreshold: number | null;
  noSpeechThreshold: number | null;
  compressionRatioThreshold: number | null;
  conditionOnPreviousText: boolean;
  promptResetOnTemperature: number;
  temperatures: number[];
  initialPrompt: string | readonly number[] | null;
  prefix: string | null;
  suppressBlank: boolean;
  suppressTokens: number[] | null;
  withoutTimestamps: boolean;
  maxInitialTimestamp: number;
  maxNewTokens: number | null;
  hotwords: string | null;
}

/** What `transcribe` reports besides the segments (faster-whisper's `TranscriptionInfo`). */
export interface TranscriptionInfo {
  language: string;
  languageProbability: number;
  duration: number;
  durationAfterVad: number;
  allLanguageProbs: Array<[string, number]> | null;
  transcriptionOptions: TranscriptionOptions;
}

/** Arguments of `WhisperModel.transcribe` (faster-whisper's keyword arguments, camelCased). */
export interface TranscribeOptions {
  language?: string | null;
  task?: "transcribe" | "translate";
  beamSize?: number;
  bestOf?: number;
  patience?: number;
  lengthPenalty?: number;
  repetitionPenalty?: number;
  noRepeatNgramSize?: number;
  temperature?: number | readonly number[];
  compressionRatioThreshold?: number | null;
  logProbThreshold?: number | null;
  noSpeechThreshold?: number | null;
  conditionOnPreviousText?: boolean;
  promptResetOnTemperature?: number;
  initialPrompt?: string | readonly number[] | null;
  prefix?: string | null;
  suppressBlank?: boolean;
  suppressTokens?: readonly number[] | null;
  withoutTimestamps?: boolean;
  maxInitialTimestamp?: number;
  maxNewTokens?: number | null;
  chunkLength?: number | null;
  hotwords?: string | null;
  languageDetectionThreshold?: number | null;
  languageDetectionSegments?: number;
  /** Not implemented; must be false. */
  wordTimestamps?: boolean;
  /** Not implemented; must be false. */
  vadFilter?: boolean;
  /** Not implemented; must be false. */
  multilingual?: boolean;
  /** Not implemented; must be null. */
  hallucinationSilenceThreshold?: number | null;
  /** Not implemented; must be "0". */
  clipTimestamps?: string;
  /** Abort decoding (checked between decoder steps). */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Model files

/** Explicit model files (faster-whisper's `files`): bytes, paths or URLs. */
export interface WhisperModelFiles {
  "config.json"?: OnnxModelSource;
  "generation_config.json"?: OnnxModelSource;
  "preprocessor_config.json"?: OnnxModelSource;
  "tokenizer.json"?: OnnxModelSource;
  /** The encoder ONNX model. */
  encoder?: OnnxModelSource;
  /** The merged decoder ONNX model (`decoder_model_merged*.onnx`). */
  decoder?: OnnxModelSource;
}

/** Options of `WhisperModel` (faster-whisper's keyword arguments, camelCased, plus ONNX ones). */
export interface WhisperModelOptions {
  /**
   * `"cpu"`, `"cuda"` or `"auto"` (default). `"cpu"` forces the CPU execution
   * provider; the others use the ONNX backend's default provider (`cuda` is not
   * selected: `@pipedog/onnx` has no GPU execution-provider option).
   */
  device?: string;
  /** faster-whisper's `compute_type`, mapped by `computeTypeToDtypes` (default `"default"`). */
  computeType?: string;
  /** Explicit weight variants; override `computeType`. */
  dtype?: WhisperDtype | Partial<WhisperDtypes>;
  /** Intra-op threads (faster-whisper's `cpu_threads`; 0 = the runtime's default). */
  cpuThreads?: number;
  /**
   * Where downloaded models are kept (faster-whisper's `download_root`).
   * Default: `modelCacheDir("whisper")`, i.e. `~/.cache/pipedog/whisper`.
   */
  downloadRoot?: string | null;
  /** Never download; use only files already in the cache (faster-whisper's `local_files_only`). */
  localFilesOnly?: boolean;
  /** Explicit files (bytes, paths or URLs); the model name is then only a label. */
  files?: WhisperModelFiles | null;
  /** Hugging Face revision (branch, tag or commit). Default `"main"`. */
  revision?: string | null;
  /** Hugging Face endpoint (default: `$HF_ENDPOINT` or `https://huggingface.co`). */
  endpoint?: string | null;
  /** `fetch` for downloads (default: the global `fetch`). */
  fetch?: typeof fetch;
  /** The ONNX backend (default: `createOnnxBackend()`). */
  backend?: OnnxBackend | Promise<OnnxBackend>;
  /**
   * Share the encoder and decoder sessions with other `WhisperModel`s using
   * the same files (default true). Both models are stateless (the KV cache is
   * passed in and out), so sharing is safe and loads the weights once per process.
   */
  shareSession?: boolean;
}

interface WhisperConfig {
  numMelBins: number;
  decoderLayers: number;
  decoderHeads: number;
  dModel: number;
  vocabSize: number;
  maxTargetPositions: number;
}

interface LoadedModel {
  config: WhisperConfig;
  isMultilingual: boolean;
  hfTokenizer: HfTokenizerLike;
  featureExtractor: FeatureExtractor;
  encoder: OnnxSession;
  decoder: OnnxSession;
  /** Decoder layer indices found in the decoder's inputs. */
  layers: number;
}

function env(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return value ? value : undefined;
}

function isLocalPath(name: string): boolean {
  return (
    name.startsWith("/") ||
    name.startsWith("./") ||
    name.startsWith("../") ||
    name.startsWith("~") ||
    name.startsWith("file:") ||
    /^[a-zA-Z]:[\\/]/.test(name)
  );
}

/** The ONNX repo (or local directory) for a faster-whisper model name, CT2 repo id or repo id. */
export function resolveModelRepo(modelSizeOrPath: string): {
  repo: string | null;
  dir: string | null;
} {
  if (isLocalPath(modelSizeOrPath)) {
    return {
      repo: null,
      dir: modelSizeOrPath.startsWith("file:")
        ? decodeURIComponent(new URL(modelSizeOrPath).pathname)
        : modelSizeOrPath,
    };
  }
  const alias = CT2_REPO_ALIASES[modelSizeOrPath] ?? modelSizeOrPath;
  const repo = ONNX_WHISPER_MODELS[alias];
  if (repo) return { repo, dir: null };
  if (modelSizeOrPath.includes("/")) return { repo: modelSizeOrPath, dir: null };
  throw new Error(
    `Invalid model size '${modelSizeOrPath}', expected one of: ${availableModels().join(", ")}`,
  );
}

/**
 * Whether a model name is known to be English-only (`.en`) or multilingual,
 * before its files are loaded; null when it can't be told from the name.
 */
export function knownMultilingual(modelSizeOrPath: string): boolean | null {
  const alias = CT2_REPO_ALIASES[modelSizeOrPath] ?? modelSizeOrPath;
  const repo =
    ONNX_WHISPER_MODELS[alias] ?? (modelSizeOrPath.includes("/") ? modelSizeOrPath : null);
  if (!repo || isLocalPath(modelSizeOrPath)) return null;
  if (alias in ONNX_WHISPER_MODELS) return !alias.endsWith(".en");
  return null;
}

async function readJson(source: OnnxModelSource): Promise<Record<string, any>> {
  const bytes = await loadModelBytes(source);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Decoding

/** The decoder's cache for a batch: per layer, decoder and encoder keys/values. */
interface KvCache {
  tensors: Record<string, OnnxTensor>;
}

interface GenerationResult {
  sequencesIds: number[][];
  /** Normalized scores (cumulative log probability / length^lengthPenalty). */
  scores: number[];
  /** Cumulative log probabilities, including `<|endoftext|>` when it was generated. */
  cumLogprobs: number[];
  noSpeechProb: number;
}

interface GenerateOptions {
  beamSize: number;
  patience: number;
  numHypotheses: number;
  samplingTemperature: number;
  lengthPenalty: number;
  maxLength: number;
  suppressBlank: boolean;
  suppressTokens: number[] | null;
  maxInitialTimestampIndex: number | null;
  signal?: AbortSignal;
}

/** Gather rows of a `[batch, ...]` float tensor. */
function gatherBatch(t: OnnxTensor, indices: readonly number[]): OnnxTensor {
  const batch = t.dims[0] as number;
  const data = t.data as Float32Array;
  const row = batch === 0 ? 0 : data.length / batch;
  const out = new Float32Array(row * indices.length);
  for (let i = 0; i < indices.length; i++) {
    const src = (indices[i] as number) * row;
    out.set(data.subarray(src, src + row), i * row);
  }
  return float32Tensor(out, [indices.length, ...t.dims.slice(1)]);
}

function isIdentity(indices: readonly number[], batch: number): boolean {
  if (indices.length !== batch) return false;
  for (let i = 0; i < indices.length; i++) if (indices[i] !== i) return false;
  return true;
}

function logSoftmax(logits: Float32Array): Float64Array {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < logits.length; i++)
    if ((logits[i] as number) > max) max = logits[i] as number;
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp((logits[i] as number) - max);
  const lse = max + Math.log(sum);
  const out = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) out[i] = (logits[i] as number) - lse;
  return out;
}

function softmaxAt(logits: Float32Array, index: number): number {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < logits.length; i++)
    if ((logits[i] as number) > max) max = logits[i] as number;
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp((logits[i] as number) - max);
  return Math.exp((logits[index] as number) - max) / sum;
}

function topK(logprobs: Float64Array, k: number): Array<[number, number]> {
  const best: Array<[number, number]> = [];
  for (let i = 0; i < logprobs.length; i++) {
    const v = logprobs[i] as number;
    if (v === Number.NEGATIVE_INFINITY) continue;
    if (best.length < k) {
      best.push([i, v]);
      best.sort((a, b) => b[1] - a[1]);
    } else if (v > (best[k - 1] as [number, number])[1]) {
      best[k - 1] = [i, v];
      best.sort((a, b) => b[1] - a[1]);
    }
  }
  return best;
}

interface Hypothesis {
  tokens: number[];
  cumLogprob: number;
}

/** faster-whisper's `WhisperModel`, running ONNX exports of the same checkpoints. */
export class WhisperModel {
  readonly modelSizeOrPath: string;
  readonly device: string;
  readonly computeType: string;
  readonly dtypes: WhisperDtypes;
  /** Seconds per timestamp token. */
  readonly timePrecision = 0.02;
  /** The decoder's maximum number of positions. */
  maxLength = 448;
  readonly inputStride = 2;

  readonly #options: WhisperModelOptions;
  #loaded: LoadedModel | null = null;
  #loading: Promise<LoadedModel> | null = null;

  /**
   * Describe the model. Nothing is read or downloaded until `load()` (or the
   * first `transcribe()`).
   *
   * @param modelSizeOrPath A faster-whisper model name (`tiny`, `base.en`,
   *   `distil-medium.en`, `large-v3-turbo`, ...), a CTranslate2 repo id that
   *   Pipecat names (`Systran/faster-distil-whisper-medium.en`, ...), which maps
   *   to the ONNX export of the same checkpoint, any Hugging Face repo id with
   *   an ONNX export, or a local directory with that layout.
   */
  constructor(modelSizeOrPath: string, options: WhisperModelOptions = {}) {
    this.modelSizeOrPath = modelSizeOrPath;
    this.device = options.device ?? "auto";
    this.computeType = options.computeType ?? "default";
    const fromComputeType = computeTypeToDtypes(this.computeType);
    const dtype = options.dtype;
    this.dtypes =
      typeof dtype === "string"
        ? { encoder: dtype, decoder: dtype }
        : { ...fromComputeType, ...(dtype ?? {}) };
    for (const d of [this.dtypes.encoder, this.dtypes.decoder]) {
      if (!(d in DTYPE_SUFFIX)) throw new Error(`Unsupported Whisper ONNX dtype '${d}'`);
    }
    if (!options.files) resolveModelRepo(modelSizeOrPath); // validate the name now
    this.#options = options;
  }

  /** Whether the model's files are loaded. */
  get loaded(): boolean {
    return this.#loaded !== null;
  }

  /**
   * Whether the model is multilingual (a vocabulary of 51865+ tokens, as
   * CTranslate2 decides). Known from the name for faster-whisper's model names
   * before loading; otherwise null until loaded.
   */
  get isMultilingual(): boolean | null {
    if (this.#loaded) return this.#loaded.isMultilingual;
    return this.#options.files ? null : knownMultilingual(this.modelSizeOrPath);
  }

  /**
   * The languages supported by the model: every Whisper language for a
   * multilingual model, `["en"]` for an English-only one, as faster-whisper
   * reports them. Null while that can't be known (a custom model not yet loaded).
   *
   * The distilled models keep their teacher's multilingual tokenizer, so
   * distil-large-v2/v3 report every language even though they were distilled
   * on English.
   */
  get supportedLanguages(): string[] | null {
    const multilingual = this.isMultilingual;
    if (multilingual === null) return null;
    return multilingual ? [...LANGUAGE_CODES] : ["en"];
  }

  /** The feature extractor (after `load()`). */
  get featureExtractor(): FeatureExtractor {
    return this.#requireLoaded().featureExtractor;
  }

  #requireLoaded(): LoadedModel {
    if (!this.#loaded) throw new Error("Whisper model is not loaded; call load() first");
    return this.#loaded;
  }

  /** Download (if needed) and load the model. Concurrent calls share one load; a failed load is retried. */
  load(): Promise<void> {
    if (this.#loaded) return Promise.resolve();
    if (!this.#loading) {
      this.#loading = this.#load();
      this.#loading.then(
        (m) => {
          this.#loaded = m;
        },
        () => {
          this.#loading = null;
        },
      );
    }
    return this.#loading.then(() => undefined);
  }

  async #resolveFiles(): Promise<Required<WhisperModelFiles>> {
    const options = this.#options;
    const files = options.files ?? {};
    const encName = `onnx/encoder_model${DTYPE_SUFFIX[this.dtypes.encoder]}.onnx`;
    const decName = `onnx/decoder_model_merged${DTYPE_SUFFIX[this.dtypes.decoder]}.onnx`;
    const wanted: Record<keyof WhisperModelFiles, string> = {
      "config.json": "config.json",
      "generation_config.json": "generation_config.json",
      "preprocessor_config.json": "preprocessor_config.json",
      "tokenizer.json": "tokenizer.json",
      encoder: encName,
      decoder: decName,
    };
    const out: Partial<Record<keyof WhisperModelFiles, OnnxModelSource>> = {};
    const missing = (Object.keys(wanted) as Array<keyof WhisperModelFiles>).filter(
      (k) => files[k] === undefined,
    );
    for (const k of Object.keys(files) as Array<keyof WhisperModelFiles>) {
      const v = files[k];
      if (v !== undefined) out[k] = v;
    }
    if (missing.length === 0) return out as Required<WhisperModelFiles>;
    if (options.files && missing.includes("encoder")) {
      throw new Error("WhisperModel: `files` must include at least `encoder` and `decoder`");
    }

    const { repo, dir } = resolveModelRepo(this.modelSizeOrPath);
    if (dir) {
      const base = dir.replace(/[\\/]+$/, "");
      for (const k of missing) out[k] = `${base}/${wanted[k]}`;
      return out as Required<WhisperModelFiles>;
    }

    const revision = options.revision ?? "main";
    const root = options.downloadRoot ?? (await modelCacheDir("whisper"));
    const local = `${root}/${(repo as string).replace("/", "--")}${revision === "main" ? "" : `@${revision}`}`;
    const endpoint = (options.endpoint ?? env("HF_ENDPOINT") ?? "https://huggingface.co").replace(
      /\/+$/,
      "",
    );
    const url = (path: string) =>
      `${endpoint}/${repo}/resolve/${encodeURIComponent(revision)}/${path}`;
    for (const k of missing) {
      const path = wanted[k];
      const dest = `${local}/${path}`;
      if (!(await fileExists(dest))) {
        if (options.localFilesOnly) {
          throw new Error(
            `Whisper model file ${dest} is not in the cache and localFilesOnly is set`,
          );
        }
        // The large fp32 exports keep their weights in `<model>.onnx_data`;
        // fetch it first, so a cached `.onnx` means both are there.
        if (
          path.endsWith(".onnx") &&
          (k === "encoder" ? this.dtypes.encoder : this.dtypes.decoder) === "fp32"
        ) {
          await this.#downloadExternalData(url(`${path}_data`), `${dest}_data`);
        }
        logger.info(`Downloading Whisper model file ${repo}/${path}...`);
        try {
          await downloadModelFile(url(path), dest, { fetch: options.fetch });
        } catch (e) {
          const hint =
            k === "encoder" || k === "decoder"
              ? ` (the ${repo} export may not have the '${k === "encoder" ? this.dtypes.encoder : this.dtypes.decoder}' variant; try computeType "int8" or "float32")`
              : "";
          throw new Error(`${e instanceof Error ? e.message : String(e)}${hint}`);
        }
      }
      out[k] = dest;
    }
    return out as Required<WhisperModelFiles>;
  }

  async #downloadExternalData(url: string, dest: string): Promise<void> {
    if (await fileExists(dest)) return;
    const doFetch = this.#options.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, { method: "HEAD", redirect: "follow" });
    } catch (e) {
      rethrowIfCancelled(e);
      return;
    }
    if (!res.ok) return;
    logger.info(`Downloading Whisper external weights ${url}...`);
    await downloadModelFile(url, dest, { fetch: this.#options.fetch });
  }

  async #load(): Promise<LoadedModel> {
    logger.debug(`Loading Whisper ONNX model ${this.modelSizeOrPath}...`);
    const files = await this.#resolveFiles();
    const [configJson, preprocessorJson, tokenizerJson] = await Promise.all([
      readJson(files["config.json"]),
      readJson(files["preprocessor_config.json"]).catch((e) => {
        logger.warning(`Could not load preprocessor config: ${e instanceof Error ? e.message : e}`);
        return {} as Record<string, any>;
      }),
      readJson(files["tokenizer.json"]),
    ]);
    const config: WhisperConfig = {
      numMelBins: configJson.num_mel_bins ?? 80,
      decoderLayers: configJson.decoder_layers,
      decoderHeads: configJson.decoder_attention_heads,
      dModel: configJson.d_model,
      vocabSize: configJson.vocab_size,
      maxTargetPositions: configJson.max_target_positions ?? 448,
    };
    const hfTokenizer = new HFTokenizer(tokenizerJson, {
      clean_up_tokenization_spaces: false,
    }) as unknown as HfTokenizerLike;
    const featureExtractor = new FeatureExtractor({
      featureSize: preprocessorJson.feature_size ?? config.numMelBins,
      samplingRate: preprocessorJson.sampling_rate,
      hopLength: preprocessorJson.hop_length,
      chunkLength: preprocessorJson.chunk_length,
      nFft: preprocessorJson.n_fft,
    });

    const backend = await (this.#options.backend ?? createOnnxBackend());
    const sessionOptions: OnnxSessionOptions = {};
    if (this.device === "cpu") sessionOptions.forceCpu = true;
    if (this.device === "cuda") {
      logger.warning(
        "Whisper (ONNX): device 'cuda' is not selectable; using the backend's default",
      );
    }
    if (this.#options.cpuThreads) sessionOptions.intraOpNumThreads = this.#options.cpuThreads;
    const open = (model: OnnxModelSource) =>
      this.#options.shareSession === false
        ? backend.createSession(model, sessionOptions)
        : sharedSession(backend, model, sessionOptions);
    const [encoder, decoder] = await Promise.all([open(files.encoder), open(files.decoder)]);
    let layers = 0;
    while (decoder.inputNames.includes(`past_key_values.${layers}.decoder.key`)) layers++;
    if (!decoder.inputNames.includes("use_cache_branch") || layers === 0) {
      throw new Error(
        "Whisper decoder must be a merged ONNX decoder (decoder_model_merged) with past_key_values inputs",
      );
    }
    this.maxLength = config.maxTargetPositions;
    logger.debug("Loaded Whisper ONNX model");
    return {
      config,
      isMultilingual: config.vocabSize >= 51865,
      hfTokenizer,
      featureExtractor,
      encoder,
      decoder,
      layers,
    };
  }

  /**
   * Transcribe 16 kHz mono float audio.
   *
   * Returns faster-whisper's `(segments, info)` pair: `info` once features are
   * computed and the language is known (detected on the first 30 s window when
   * `language` is not given), and the segments lazily: each 30 s window is
   * decoded as the iterator is advanced.
   */
  async transcribe(
    audio: Float32Array,
    options: TranscribeOptions = {},
  ): Promise<[AsyncGenerator<Segment, void, unknown>, TranscriptionInfo]> {
    if (options.wordTimestamps) throw new Error("word_timestamps is not implemented");
    if (options.vadFilter) throw new Error("vad_filter is not implemented");
    if (options.hallucinationSilenceThreshold != null) {
      throw new Error("hallucination_silence_threshold is not implemented");
    }
    if (options.clipTimestamps !== undefined && options.clipTimestamps !== "0") {
      throw new Error("clip_timestamps is not implemented");
    }
    if ((options.repetitionPenalty ?? 1) !== 1)
      throw new Error("repetition_penalty is not implemented");
    if ((options.noRepeatNgramSize ?? 0) !== 0)
      throw new Error("no_repeat_ngram_size is not implemented");

    await this.load();
    const m = this.#requireLoaded();
    const fe = m.featureExtractor;
    const samplingRate = fe.samplingRate;

    let multilingual = options.multilingual ?? false;
    if (multilingual && !m.isMultilingual) {
      logger.warning(
        "The current model is English-only but the multilingual parameter is set to True; setting to False instead.",
      );
      multilingual = false;
    }
    if (multilingual)
      throw new Error("multilingual (per-window language detection) is not implemented");

    const duration = audio.length / samplingRate;
    const features = fe.compute(audio, { chunkLength: options.chunkLength ?? null });

    let language = options.language ?? null;
    let languageProbability = 1;
    let allLanguageProbs: Array<[string, number]> | null = null;
    // As in faster-whisper, the language-detection encoder output isn't reused.
    const encoderOutput: OnnxTensor | null = null;
    if (language === null) {
      if (!m.isMultilingual) {
        language = "en";
        languageProbability = 1;
      } else {
        const detected = await this.#detectLanguage(features, {
          languageDetectionSegments: options.languageDetectionSegments ?? 1,
          languageDetectionThreshold: options.languageDetectionThreshold ?? 0.5,
        });
        language = detected.language;
        languageProbability = detected.languageProbability;
        allLanguageProbs = detected.allLanguageProbs;
        logger.info(
          `Detected language '${language}' with probability ${languageProbability.toFixed(2)}`,
        );
      }
    } else {
      if (!m.isMultilingual && language !== "en") {
        logger.warning(
          `The current model is English-only but the language parameter is set to '${language}'; using 'en' instead.`,
        );
        language = "en";
      }
      languageProbability = 1;
    }

    const tokenizer = new Tokenizer(m.hfTokenizer, m.isMultilingual, {
      task: options.task ?? "transcribe",
      language,
    });

    const temperature = options.temperature ?? [0.0, 0.2, 0.4, 0.6, 0.8, 1.0];
    const suppressTokens = options.suppressTokens === undefined ? [-1] : options.suppressTokens;
    const transcriptionOptions: TranscriptionOptions = {
      beamSize: options.beamSize ?? 5,
      bestOf: options.bestOf ?? 5,
      patience: options.patience ?? 1,
      lengthPenalty: options.lengthPenalty ?? 1,
      repetitionPenalty: options.repetitionPenalty ?? 1,
      noRepeatNgramSize: options.noRepeatNgramSize ?? 0,
      logProbThreshold: options.logProbThreshold === undefined ? -1.0 : options.logProbThreshold,
      noSpeechThreshold: options.noSpeechThreshold === undefined ? 0.6 : options.noSpeechThreshold,
      compressionRatioThreshold:
        options.compressionRatioThreshold === undefined ? 2.4 : options.compressionRatioThreshold,
      conditionOnPreviousText: options.conditionOnPreviousText ?? true,
      promptResetOnTemperature: options.promptResetOnTemperature ?? 0.5,
      temperatures: typeof temperature === "number" ? [temperature] : [...temperature],
      initialPrompt: options.initialPrompt ?? null,
      prefix: options.prefix ?? null,
      suppressBlank: options.suppressBlank ?? true,
      suppressTokens:
        suppressTokens && suppressTokens.length > 0
          ? getSuppressedTokens(tokenizer, suppressTokens)
          : (suppressTokens as number[] | null),
      withoutTimestamps: options.withoutTimestamps ?? false,
      maxInitialTimestamp: options.maxInitialTimestamp ?? 1.0,
      maxNewTokens: options.maxNewTokens ?? null,
      hotwords: options.hotwords ?? null,
    };

    const segments = this.generateSegments(
      features,
      tokenizer,
      transcriptionOptions,
      encoderOutput,
      options.signal,
    );
    const info: TranscriptionInfo = {
      language,
      languageProbability,
      duration,
      durationAfterVad: duration,
      allLanguageProbs,
      transcriptionOptions,
    };
    return [segments, info];
  }

  /** Run the encoder on one `(nMels, 3000)` window. */
  async encode(window: Float32Array): Promise<OnnxTensor> {
    const m = this.#requireLoaded();
    const nMels = m.featureExtractor.featureSize;
    const out = await m.encoder.run({
      input_features: float32Tensor(window, [1, nMels, window.length / nMels]),
    });
    const hidden = out.last_hidden_state ?? Object.values(out)[0];
    if (!hidden) throw new Error("Whisper encoder returned no output");
    return hidden;
  }

  async #detectLanguage(
    features: WhisperFeatures,
    options: { languageDetectionSegments: number; languageDetectionThreshold: number },
  ): Promise<{
    language: string;
    languageProbability: number;
    allLanguageProbs: Array<[string, number]>;
  }> {
    const m = this.#requireLoaded();
    const nbMax = m.featureExtractor.nbMaxFrames;
    const total = Math.min(features.nFrames, options.languageDetectionSegments * nbMax);
    const votes = new Map<string, number[]>();
    let language = "en";
    let languageProbability = 0;
    let allLanguageProbs: Array<[string, number]> = [];
    let detected = false;
    for (let i = 0; i < Math.max(total, 1); i += nbMax) {
      const encoderOutput = await this.encode(
        padOrTrimFeatures(features, i, Math.min(nbMax, total - i)),
      );
      allLanguageProbs = await this.#languageProbs(encoderOutput);
      [language, languageProbability] = allLanguageProbs[0] as [string, number];
      if (languageProbability > options.languageDetectionThreshold) {
        detected = true;
        break;
      }
      const list = votes.get(language) ?? [];
      list.push(languageProbability);
      votes.set(language, list);
    }
    if (!detected && votes.size > 0) {
      // Majority vote of the most probable language per window.
      let best = "";
      let bestCount = -1;
      for (const [lang, probs] of votes) {
        if (probs.length > bestCount) {
          best = lang;
          bestCount = probs.length;
        }
      }
      language = best;
      languageProbability = Math.max(...(votes.get(best) as number[]));
    }
    return { language, languageProbability, allLanguageProbs };
  }

  /** Language probabilities at `<|startoftranscript|>`, most probable first. */
  async #languageProbs(encoderOutput: OnnxTensor): Promise<Array<[string, number]>> {
    const m = this.#requireLoaded();
    const sot = requireTokenId(m.hfTokenizer, "<|startoftranscript|>");
    const { logits } = await this.#decoderStep([[sot]], encoderOutput, null);
    const vocab = logits.dims[2] as number;
    const row = (logits.data as Float32Array).subarray(0, vocab);
    const langs: Array<[string, number]> = [];
    for (const code of LANGUAGE_CODES) {
      const id = m.hfTokenizer.token_to_id(`<|${code}|>`);
      if (id !== undefined && id < vocab) langs.push([code, row[id] as number]);
    }
    let max = Number.NEGATIVE_INFINITY;
    for (const [, v] of langs) max = Math.max(max, v);
    let sum = 0;
    for (const l of langs) {
      l[1] = Math.exp(l[1] - max);
      sum += l[1];
    }
    for (const l of langs) l[1] /= sum;
    return langs.sort((a, b) => b[1] - a[1]);
  }

  /**
   * One decoder pass. Without `cache`, `inputIds` is the whole prompt and the
   * encoder keys/values are computed; with it, one token per sequence.
   */
  async #decoderStep(
    inputIds: number[][],
    encoderHidden: OnnxTensor,
    cache: KvCache | null,
  ): Promise<{ logits: OnnxTensor; cache: KvCache }> {
    const m = this.#requireLoaded();
    const batch = inputIds.length;
    const seq = (inputIds[0] as number[]).length;
    const ids = new BigInt64Array(batch * seq);
    for (let b = 0; b < batch; b++) {
      for (let s = 0; s < seq; s++)
        ids[b * seq + s] = BigInt((inputIds[b] as number[])[s] as number);
    }
    const heads = m.config.decoderHeads;
    const headDim = m.config.dModel / heads;
    const feeds: Record<string, OnnxTensor> = {
      input_ids: int64Tensor(ids, [batch, seq]),
      encoder_hidden_states: encoderHidden,
      use_cache_branch: boolTensor(new Uint8Array([cache ? 1 : 0]), [1]),
    };
    const empty = float32Tensor(new Float32Array(0), [batch, heads, 0, headDim]);
    for (let l = 0; l < m.layers; l++) {
      for (const part of ["decoder.key", "decoder.value", "encoder.key", "encoder.value"]) {
        const name = `past_key_values.${l}.${part}`;
        feeds[name] = cache ? (cache.tensors[name] as OnnxTensor) : empty;
      }
    }
    const out = await m.decoder.run(feeds);
    const logits = out.logits;
    if (!logits) throw new Error("Whisper decoder returned no logits");
    const tensors: Record<string, OnnxTensor> = {};
    for (let l = 0; l < m.layers; l++) {
      for (const kind of ["decoder", "encoder"]) {
        for (const kv of ["key", "value"]) {
          const name = `past_key_values.${l}.${kind}.${kv}`;
          // The encoder keys/values are computed by the first pass only; the
          // cache branch passes them through, so keep the first ones.
          tensors[name] =
            kind === "encoder" && cache
              ? (cache.tensors[name] as OnnxTensor)
              : (out[`present.${l}.${kind}.${kv}`] as OnnxTensor);
        }
      }
    }
    return { logits, cache: { tensors } };
  }

  #reorder(cache: KvCache, encoderHidden: OnnxTensor, indices: number[]): [KvCache, OnnxTensor] {
    const batch = encoderHidden.dims[0] as number;
    if (isIdentity(indices, batch)) return [cache, encoderHidden];
    const tensors: Record<string, OnnxTensor> = {};
    for (const [name, t] of Object.entries(cache.tensors)) tensors[name] = gatherBatch(t, indices);
    return [{ tensors }, gatherBatch(encoderHidden, indices)];
  }

  /** Mask logits as CTranslate2's Whisper logits processors do. */
  #processLogits(
    logits: Float32Array,
    generated: readonly number[],
    tokenizer: Tokenizer,
    options: GenerateOptions,
    withoutTimestamps: boolean,
    blankIds: readonly number[],
  ): void {
    const NEG = Number.NEGATIVE_INFINITY;
    const step = generated.length;
    const vocab = logits.length;
    const eot = tokenizer.eot;
    if (options.suppressBlank && step === 0) {
      for (const id of blankIds) logits[id] = NEG;
      logits[eot] = NEG;
    }
    if (options.suppressTokens) {
      for (const id of options.suppressTokens) if (id < vocab) logits[id] = NEG;
    }
    if (withoutTimestamps) return;

    const tsBegin = tokenizer.timestampBegin;
    logits[tokenizer.noTimestamps] = NEG;
    const n = generated.length;
    const lastWasTimestamp = n >= 1 && (generated[n - 1] as number) >= tsBegin;
    const penultimateWasTimestamp = n < 2 || (generated[n - 2] as number) >= tsBegin;
    if (lastWasTimestamp) {
      if (penultimateWasTimestamp)
        logits.fill(NEG, tsBegin); // has to be non-timestamp
      else logits.fill(NEG, 0, eot); // cannot be normal text tokens
    }
    let lastTimestamp = -1;
    for (const t of generated) if (t >= tsBegin) lastTimestamp = t;
    if (lastTimestamp >= 0) {
      // Timestamps shouldn't decrease; each segment must have a nonzero length.
      const timestampLast =
        lastWasTimestamp && !penultimateWasTimestamp ? lastTimestamp : lastTimestamp + 1;
      logits.fill(NEG, tsBegin, timestampLast);
    }
    if (step === 0) {
      // Suppress generating non-timestamp tokens at the beginning.
      logits.fill(NEG, 0, tsBegin);
      if (options.maxInitialTimestampIndex !== null) {
        logits.fill(NEG, tsBegin + options.maxInitialTimestampIndex + 1);
      }
    }
    // If the timestamps' total probability beats any text token, force a timestamp.
    const lp = logSoftmax(logits);
    let maxText = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < tsBegin; i++) if ((lp[i] as number) > maxText) maxText = lp[i] as number;
    let maxTs = Number.NEGATIVE_INFINITY;
    for (let i = tsBegin; i < vocab; i++) if ((lp[i] as number) > maxTs) maxTs = lp[i] as number;
    if (maxTs !== Number.NEGATIVE_INFINITY) {
      let sum = 0;
      for (let i = tsBegin; i < vocab; i++) sum += Math.exp((lp[i] as number) - maxTs);
      const timestampLogprob = maxTs + Math.log(sum);
      if (timestampLogprob > maxText) logits.fill(NEG, 0, tsBegin);
    }
  }

  /**
   * Decode one window: beam search at temperature 0, best-of-N sampling above
   * it (CTranslate2's `Whisper.generate` for one batch item).
   */
  async generate(
    encoderOutput: OnnxTensor,
    prompt: number[],
    tokenizer: Tokenizer,
    options: GenerateOptions,
  ): Promise<GenerationResult> {
    const withoutTimestamps = prompt.includes(tokenizer.noTimestamps);
    const eot = tokenizer.eot;
    const sotIndex = prompt.indexOf(tokenizer.sot);
    const blankIds = tokenizer.encode(" ");
    const sampling = options.samplingTemperature > 0;
    const maxNew = Math.max(0, Math.min(options.maxLength, this.maxLength) - prompt.length);

    // First pass over the whole prompt.
    const first = await this.#decoderStep([prompt], encoderOutput, null);
    const vocab = first.logits.dims[2] as number;
    const firstLogits = first.logits.data as Float32Array;
    const noSpeechProb =
      sotIndex >= 0
        ? softmaxAt(
            firstLogits.subarray(sotIndex * vocab, (sotIndex + 1) * vocab),
            tokenizer.noSpeech,
          )
        : 0;
    let stepLogits: Float32Array[] = [
      firstLogits.slice((prompt.length - 1) * vocab, prompt.length * vocab),
    ];
    let cache = first.cache;
    let hidden = encoderOutput;

    const finished: Hypothesis[] = [];
    let live: Hypothesis[] = [{ tokens: [], cumLogprob: 0 }];
    const beamSize = sampling ? 1 : Math.max(1, options.beamSize);
    const maxFinished = sampling
      ? options.numHypotheses
      : Math.max(1, Math.round(beamSize * options.patience));

    if (sampling && options.numHypotheses > 1) {
      // Independent samples run as one batch.
      const idx = new Array<number>(options.numHypotheses).fill(0);
      [cache, hidden] = this.#reorder(cache, hidden, idx);
      stepLogits = idx.map(() => (stepLogits[0] as Float32Array).slice());
      live = idx.map(() => ({ tokens: [], cumLogprob: 0 }));
    }

    for (let step = 0; step < maxNew && live.length > 0; step++) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
      const next: Hypothesis[] = [];
      const parents: number[] = [];
      if (sampling) {
        for (let b = 0; b < live.length; b++) {
          const hyp = live[b] as Hypothesis;
          const logits = stepLogits[b] as Float32Array;
          this.#processLogits(logits, hyp.tokens, tokenizer, options, withoutTimestamps, blankIds);
          const lp = logSoftmax(logits);
          // Sample from softmax(logits / T).
          const scaled = new Float32Array(logits.length);
          for (let i = 0; i < logits.length; i++)
            scaled[i] = (logits[i] as number) / options.samplingTemperature;
          const sp = logSoftmax(scaled);
          let r = Math.random();
          let token = eot;
          for (let i = 0; i < sp.length; i++) {
            const p = Math.exp(sp[i] as number);
            if (r < p) {
              token = i;
              break;
            }
            r -= p;
          }
          const cand = {
            tokens: [...hyp.tokens, token],
            cumLogprob: hyp.cumLogprob + (lp[token] as number),
          };
          if (token === eot) finished.push({ tokens: hyp.tokens, cumLogprob: cand.cumLogprob });
          else {
            next.push(cand);
            parents.push(b);
          }
        }
      } else {
        const candidates: Array<{ parent: number; token: number; score: number }> = [];
        for (let b = 0; b < live.length; b++) {
          const hyp = live[b] as Hypothesis;
          const logits = stepLogits[b] as Float32Array;
          this.#processLogits(logits, hyp.tokens, tokenizer, options, withoutTimestamps, blankIds);
          const lp = logSoftmax(logits);
          for (const [token, logprob] of topK(lp, beamSize + 1)) {
            candidates.push({ parent: b, token, score: hyp.cumLogprob + logprob });
          }
        }
        candidates.sort((a, b) => b.score - a.score);
        for (const c of candidates) {
          const parent = live[c.parent] as Hypothesis;
          if (c.token === eot) {
            if (finished.length < maxFinished) {
              finished.push({ tokens: parent.tokens, cumLogprob: c.score });
            }
          } else {
            next.push({ tokens: [...parent.tokens, c.token], cumLogprob: c.score });
            parents.push(c.parent);
          }
          if (next.length >= beamSize) break;
        }
        if (finished.length >= maxFinished) break;
      }
      live = next;
      if (live.length === 0 || step === maxNew - 1) break;
      [cache, hidden] = this.#reorder(cache, hidden, parents);
      const stepOut = await this.#decoderStep(
        live.map((h) => [h.tokens[h.tokens.length - 1] as number]),
        hidden,
        cache,
      );
      cache = stepOut.cache;
      const data = stepOut.logits.data as Float32Array;
      stepLogits = live.map((_, b) => data.slice(b * vocab, (b + 1) * vocab));
    }

    // Unfinished hypotheses (max length reached) count as finished.
    const pool = finished.length > 0 ? finished : live;
    const scored = pool.map((h) => {
      const length = h.tokens.length;
      const norm = options.lengthPenalty === 0 ? 1 : Math.max(1, length) ** options.lengthPenalty;
      return { h, score: h.cumLogprob / norm };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0] ?? { h: { tokens: [], cumLogprob: 0 }, score: 0 };
    return {
      sequencesIds: [best.h.tokens],
      scores: [best.score],
      cumLogprobs: [best.h.cumLogprob],
      noSpeechProb,
    };
  }

  /** faster-whisper's `generate_with_fallback`. */
  async generateWithFallback(
    encoderOutput: OnnxTensor,
    prompt: number[],
    tokenizer: Tokenizer,
    options: TranscriptionOptions,
    signal?: AbortSignal,
  ): Promise<[GenerationResult, number, number, number]> {
    type Decoded = [GenerationResult, number, number, number];
    let decodeResult: Decoded | null = null;
    const allResults: Decoded[] = [];
    const belowCrThresholdResults: Decoded[] = [];
    const maxInitialTimestampIndex = Math.round(options.maxInitialTimestamp / this.timePrecision);
    const maxLength =
      options.maxNewTokens !== null ? prompt.length + options.maxNewTokens : this.maxLength;
    if (maxLength > this.maxLength) {
      throw new Error(
        `The length of the prompt is ${prompt.length}, and the \`max_new_tokens\` ` +
          `${maxLength - prompt.length}. Thus, the combined length of the prompt ` +
          `and \`max_new_tokens\` is: ${maxLength}. This exceeds the ` +
          `\`max_length\` of the Whisper model: ${this.maxLength}. ` +
          "You should either reduce the length of your prompt, or " +
          "reduce the value of `max_new_tokens`, " +
          `so that their combined length is less that ${this.maxLength}.`,
      );
    }

    let lastTemperature = 0;
    let fellThrough = true;
    for (const temperature of options.temperatures) {
      lastTemperature = temperature;
      const result = await this.generate(encoderOutput, prompt, tokenizer, {
        beamSize: temperature > 0 ? 1 : options.beamSize,
        patience: options.patience,
        numHypotheses: temperature > 0 ? options.bestOf : 1,
        samplingTemperature: temperature,
        lengthPenalty: options.lengthPenalty,
        maxLength,
        suppressBlank: options.suppressBlank,
        suppressTokens: options.suppressTokens,
        maxInitialTimestampIndex,
        signal,
      });
      const tokens = result.sequencesIds[0] as number[];
      // Recover the average log prob from the score, as faster-whisper does.
      const seqLen = tokens.length;
      const cumLogprob = (result.scores[0] as number) * seqLen ** options.lengthPenalty;
      const avgLogprob = cumLogprob / (seqLen + 1);
      const text = tokenizer.decode(tokens).trim();
      const compressionRatio = await getCompressionRatio(text);
      decodeResult = [result, avgLogprob, temperature, compressionRatio];
      allResults.push(decodeResult);

      let needsFallback = false;
      if (options.compressionRatioThreshold !== null) {
        if (compressionRatio > options.compressionRatioThreshold) {
          needsFallback = true; // too repetitive
          logger.debug(
            `Compression ratio threshold is not met with temperature ${temperature.toFixed(1)} ` +
              `(${compressionRatio} > ${options.compressionRatioThreshold})`,
          );
        } else {
          belowCrThresholdResults.push(decodeResult);
        }
      }
      if (options.logProbThreshold !== null && avgLogprob < options.logProbThreshold) {
        needsFallback = true; // average log probability is too low
        logger.debug(
          `Log probability threshold is not met with temperature ${temperature.toFixed(1)} ` +
            `(${avgLogprob} < ${options.logProbThreshold})`,
        );
      }
      if (
        options.noSpeechThreshold !== null &&
        result.noSpeechProb > options.noSpeechThreshold &&
        options.logProbThreshold !== null &&
        avgLogprob < options.logProbThreshold
      ) {
        needsFallback = false; // silence
      }
      if (!needsFallback) {
        fellThrough = false;
        break;
      }
    }
    if (fellThrough) {
      // All failed: the result with the highest average log probability.
      const pool = belowCrThresholdResults.length > 0 ? belowCrThresholdResults : allResults;
      let best = pool[0] as Decoded;
      for (const r of pool) if (r[1] > best[1]) best = r;
      // Pass the final temperature on for prompt_reset_on_temperature.
      decodeResult = [best[0], best[1], lastTemperature, best[3]];
    }
    return decodeResult as Decoded;
  }

  /** faster-whisper's `get_prompt`. */
  getPrompt(
    tokenizer: Tokenizer,
    previousTokens: number[],
    options: { withoutTimestamps?: boolean; prefix?: string | null; hotwords?: string | null } = {},
  ): number[] {
    const prompt: number[] = [];
    const { withoutTimestamps = false, prefix = null, hotwords = null } = options;
    const half = Math.floor(this.maxLength / 2);
    if (previousTokens.length > 0 || (hotwords && !prefix)) {
      prompt.push(tokenizer.sotPrev);
      if (hotwords && !prefix) {
        let hotwordsTokens = tokenizer.encode(` ${hotwords.trim()}`);
        if (hotwordsTokens.length >= half) hotwordsTokens = hotwordsTokens.slice(0, half - 1);
        prompt.push(...hotwordsTokens);
      }
      if (previousTokens.length > 0) prompt.push(...previousTokens.slice(-(half - 1)));
    }
    prompt.push(...tokenizer.sotSequence);
    if (withoutTimestamps) prompt.push(tokenizer.noTimestamps);
    if (prefix) {
      let prefixTokens = tokenizer.encode(` ${prefix.trim()}`);
      if (prefixTokens.length >= half) prefixTokens = prefixTokens.slice(0, half - 1);
      if (!withoutTimestamps) prompt.push(tokenizer.timestampBegin);
      prompt.push(...prefixTokens);
    }
    return prompt;
  }

  /** faster-whisper's `_split_segments_by_timestamps`. */
  splitSegmentsByTimestamps(
    tokenizer: Tokenizer,
    tokens: number[],
    timeOffset: number,
    segmentSize: number,
    segmentDuration: number,
    seek: number,
  ): [Array<{ seek: number; start: number; end: number; tokens: number[] }>, number, boolean] {
    const currentSegments: Array<{ seek: number; start: number; end: number; tokens: number[] }> =
      [];
    const tsBegin = tokenizer.timestampBegin;
    const n = tokens.length;
    const singleTimestampEnding =
      n >= 2 && (tokens[n - 2] as number) < tsBegin && tsBegin <= (tokens[n - 1] as number);
    const consecutiveTimestamps: number[] = [];
    for (let i = 1; i < n; i++) {
      if ((tokens[i] as number) >= tsBegin && (tokens[i - 1] as number) >= tsBegin) {
        consecutiveTimestamps.push(i);
      }
    }
    if (consecutiveTimestamps.length > 0) {
      const slices = [...consecutiveTimestamps];
      if (singleTimestampEnding) slices.push(n);
      let lastSlice = 0;
      for (const currentSlice of slices) {
        const sliced = tokens.slice(lastSlice, currentSlice);
        const startPos = (sliced[0] as number) - tsBegin;
        const endPos = (sliced[sliced.length - 1] as number) - tsBegin;
        currentSegments.push({
          seek,
          start: timeOffset + startPos * this.timePrecision,
          end: timeOffset + endPos * this.timePrecision,
          tokens: sliced,
        });
        lastSlice = currentSlice;
      }
      if (singleTimestampEnding) {
        // A single timestamp at the end means no speech after the last timestamp.
        seek += segmentSize;
      } else {
        // Otherwise ignore the unfinished segment and seek to the last timestamp.
        const lastTimestampPosition = (tokens[lastSlice - 1] as number) - tsBegin;
        seek += lastTimestampPosition * this.inputStride;
      }
    } else {
      let duration = segmentDuration;
      const timestamps = tokens.filter((t) => t >= tsBegin);
      if (timestamps.length > 0 && timestamps[timestamps.length - 1] !== tsBegin) {
        const lastTimestampPosition = (timestamps[timestamps.length - 1] as number) - tsBegin;
        duration = lastTimestampPosition * this.timePrecision;
      }
      currentSegments.push({ seek, start: timeOffset, end: timeOffset + duration, tokens });
      seek += segmentSize;
    }
    return [currentSegments, seek, singleTimestampEnding];
  }

  /** faster-whisper's `generate_segments` (without word timestamps). */
  async *generateSegments(
    features: WhisperFeatures,
    tokenizer: Tokenizer,
    options: TranscriptionOptions,
    encoderOutput: OnnxTensor | null = null,
    signal?: AbortSignal,
  ): AsyncGenerator<Segment, void, unknown> {
    const fe = this.featureExtractor;
    const contentFrames = features.nFrames - 1;
    let idx = 0;
    let seek = 0;
    const seekClipEnd = contentFrames;
    const allTokens: number[] = [];
    let promptResetSince = 0;

    if (options.initialPrompt !== null) {
      if (typeof options.initialPrompt === "string") {
        allTokens.push(...tokenizer.encode(` ${options.initialPrompt.trim()}`));
      } else {
        allTokens.push(...options.initialPrompt);
      }
    }

    while (seek < seekClipEnd) {
      const timeOffset = seek * fe.timePerFrame;
      const segmentSize = Math.min(fe.nbMaxFrames, contentFrames - seek, seekClipEnd - seek);
      const segmentDuration = segmentSize * fe.timePerFrame;
      logger.debug(`Processing segment at ${timeOffset.toFixed(3)}s`);

      const previousTokens = allTokens.slice(promptResetSince);
      if (seek > 0 || encoderOutput === null) {
        encoderOutput = await this.encode(padOrTrimFeatures(features, seek, segmentSize));
      }

      const prompt = this.getPrompt(tokenizer, previousTokens, {
        withoutTimestamps: options.withoutTimestamps,
        prefix: seek === 0 ? options.prefix : null,
        hotwords: options.hotwords,
      });

      const [result, avgLogprob, temperature, compressionRatio] = await this.generateWithFallback(
        encoderOutput,
        prompt,
        tokenizer,
        options,
        signal,
      );

      if (options.noSpeechThreshold !== null) {
        // No voice activity check.
        let shouldSkip = result.noSpeechProb > options.noSpeechThreshold;
        if (options.logProbThreshold !== null && avgLogprob > options.logProbThreshold) {
          // Don't skip if the logprob is high enough, despite the no_speech_prob.
          shouldSkip = false;
        }
        if (shouldSkip) {
          logger.debug(
            `No speech threshold is met (${result.noSpeechProb} > ${options.noSpeechThreshold})`,
          );
          // Fast-forward to the next segment boundary.
          seek += segmentSize;
          continue;
        }
      }

      const tokens = result.sequencesIds[0] as number[];
      const previousSeek = seek;
      const [currentSegments, nextSeek] = this.splitSegmentsByTimestamps(
        tokenizer,
        tokens,
        timeOffset,
        segmentSize,
        segmentDuration,
        seek,
      );
      seek = nextSeek;

      for (const segment of currentSegments) {
        const text = tokenizer.decode(segment.tokens);
        if (segment.start === segment.end || !text.trim()) continue;
        allTokens.push(...segment.tokens);
        idx += 1;
        yield {
          id: idx,
          seek: previousSeek,
          start: segment.start,
          end: segment.end,
          text,
          tokens: segment.tokens,
          temperature,
          avgLogprob,
          compressionRatio,
          noSpeechProb: result.noSpeechProb,
          words: null,
        };
      }

      if (!options.conditionOnPreviousText || temperature > options.promptResetOnTemperature) {
        if (options.conditionOnPreviousText) {
          logger.debug(
            `Reset prompt. prompt_reset_on_temperature threshold is met ${temperature} > ${options.promptResetOnTemperature}`,
          );
        }
        promptResetSince = allTokens.length;
      }
    }
  }
}
