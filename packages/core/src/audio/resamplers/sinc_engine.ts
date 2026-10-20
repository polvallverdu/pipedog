// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Pure-TypeScript fallback resampler engine (windowed sinc).
 *
 * Used when the default WASM engine (`@pipedog/resampler-wasm`) cannot be
 * loaded, so resampling keeps working on any runtime without WebAssembly.
 *
 * Each output sample is a direct convolution of the input with a
 * Kaiser-windowed sinc lowpass, centred on the output instant (zero phase, so
 * the output is time-aligned with the input). The kernel is read from a
 * precomputed float32 table (1024 points per zero crossing, linearly
 * interpolated). Presets follow soxr's design: the stopband starts at the
 * lower of the two Nyquist frequencies, MQ/HQ/VHQ share a passband edge of
 * 0.91 x Nyquist and differ in attenuation (so in filter length), LQ rolls off
 * early, QQ is short and cheap.
 *
 * Quality, honestly: this is not libsoxr, and the table interpolation limits
 * the noise floor to roughly -120 dB (soxr's VHQ targets ~170 dB). Measured
 * with float tones, 48 kHz -> 8 kHz (N = output Nyquist):
 *
 * | preset | zeros/side | flat (< 0.1 dB) to | -3 dB at | -6 dB at | stopband from 1.025 x N |
 * |---|---|---|---|---|---|
 * | QQ  | 14 | ~0.8 x N  | ~0.875 x N | ~0.9 x N   | >= 50 dB  |
 * | LQ  | 16 | ~0.7 x N  | ~0.81 x N  | ~0.84 x N  | >= 95 dB  |
 * | MQ  | 66 | ~0.91 x N | ~0.95 x N  | 0.955 x N  | >= 100 dB |
 * | HQ  | 83 | ~0.91 x N | ~0.95 x N  | 0.955 x N  | >= 120 dB |
 * | VHQ | 98 | ~0.91 x N | ~0.95 x N  | 0.955 x N  | >= 120 dB |
 *
 * ("zeros/side" are the sinc's zero crossings on each side of the centre,
 * counted at the lower of the two rates; each output sample costs about
 * twice that many multiply-adds, scaled by the rate ratio when downsampling.)
 * Speed: plain scalar JS, about 190 ms for 10 s of 16 kHz -> 48 kHz at VHQ
 * on Apple Silicon (Bun), 35 ms at QQ: fine for real-time voice, but on
 * Workers' CPU budget prefer the WASM engine or a lower preset.
 *
 * Streams keep their history across chunks: chunks of any size give the same
 * output as one call with the whole signal. `resampleChunk(x, true)` (and the
 * one-shot `resample`) pad with silence so that the stream emits exactly
 * round(totalInputFrames * outRate / inRate) frames, then reset, matching the
 * WASM engine.
 */

import type { SoxrQuality } from "./base_audio_resampler.ts";
import type { ResamplerEngine, ResamplerStream, ResamplerStreamOptions } from "./engine.ts";

/**
 * A preset is designed like soxr's: a passband edge and a stopband
 * attenuation, with the stopband starting at the lower Nyquist frequency.
 * As in soxr, MQ, HQ and VHQ share the passband (about 0.91 x Nyquist) and
 * differ in attenuation (so in filter length); LQ has a wide roll-off.
 */
interface PresetSpec {
  /** Passband edge, as a fraction of the lower Nyquist frequency. */
  passband: number;
  /** Stopband attenuation in dB (Kaiser design target). */
  attenuation: number;
}

const SPECS: Record<SoxrQuality, PresetSpec> = {
  QQ: { passband: 0.8, attenuation: 50 },
  LQ: { passband: 0.676, attenuation: 96 },
  MQ: { passband: 0.91, attenuation: 96 },
  HQ: { passband: 0.91, attenuation: 120 },
  VHQ: { passband: 0.91, attenuation: 140 },
};

interface Preset {
  /** Zero crossings on each side of the kernel centre. */
  zeros: number;
  /** -6 dB cutoff, as a fraction of the lower Nyquist frequency. */
  cutoff: number;
  /** Kaiser window beta. */
  beta: number;
}

/** Kaiser window design (Kaiser's formulas for beta and length). */
function design({ passband, attenuation }: PresetSpec): Preset {
  const transition = 1 - passband; // in units of the lower Nyquist frequency
  const cutoff = (1 + passband) / 2;
  const beta =
    attenuation > 50
      ? 0.1102 * (attenuation - 8.7)
      : 0.5842 * (attenuation - 21) ** 0.4 + 0.07886 * (attenuation - 21);
  // Total length in samples of the lower rate, then in zero crossings per side.
  const length = (attenuation - 7.95) / (2.285 * Math.PI * transition);
  const zeros = Math.ceil((length / 2) * cutoff);
  return { zeros, cutoff, beta };
}

const PRESETS = Object.fromEntries(
  Object.entries(SPECS).map(([q, spec]) => [q, design(spec)]),
) as Record<SoxrQuality, Preset>;

/** Table points per zero crossing (linear interpolation error ~ -118 dB). */
const OVERSAMPLE = 1024;

/** Zeroth-order modified Bessel function of the first kind. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

const TABLES = new Map<SoxrQuality, Float32Array>();

/** sinc(x) * kaiser(x / zeros) for x in [0, zeros], OVERSAMPLE points per unit (plus guard). */
function kernelTable(quality: SoxrQuality): Float32Array {
  let table = TABLES.get(quality);
  if (table) return table;
  const { zeros, beta } = PRESETS[quality];
  const n = zeros * OVERSAMPLE;
  table = new Float32Array(n + 2);
  const i0b = besselI0(beta);
  for (let i = 0; i <= n; i++) {
    const x = i / OVERSAMPLE;
    const r = x / zeros;
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    const s = i === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    table[i] = s * w;
  }
  TABLES.set(quality, table);
  return table;
}

function checkRates(inRate: number, outRate: number): void {
  if (!(inRate > 0) || !(outRate > 0) || !Number.isFinite(inRate) || !Number.isFinite(outRate)) {
    throw new Error(`invalid sample rates: ${inRate}->${outRate}`);
  }
}

/** One channel of a streaming windowed-sinc resampler. */
class SincChannel {
  readonly #step: number; // input samples per output sample
  readonly #scale: number; // 2 * fc (fc in cycles per input sample)
  readonly #halfWidth: number; // kernel half width in input samples
  readonly #table: Float32Array;
  readonly #tableScale: number; // table index per input-sample distance

  /** Input history; #buf[0] is absolute input index #base. */
  #buf = new Float64Array(256);
  #len = 0;
  #base = 0;
  /** Total input samples seen and next output index (absolute). */
  #totalIn = 0;
  #nextOut = 0;

  constructor(inRate: number, outRate: number, quality: SoxrQuality) {
    const preset = PRESETS[quality];
    this.#step = inRate / outRate;
    const fc = 0.5 * Math.min(1, outRate / inRate) * preset.cutoff;
    this.#scale = 2 * fc;
    this.#halfWidth = preset.zeros / this.#scale;
    this.#table = kernelTable(quality);
    this.#tableScale = this.#scale * OVERSAMPLE;
  }

  #append(samples: ArrayLike<number>, start: number, stride: number, count: number): void {
    if (this.#len + count > this.#buf.length) {
      const grown = new Float64Array(Math.max(this.#buf.length * 2, this.#len + count));
      grown.set(this.#buf.subarray(0, this.#len));
      this.#buf = grown;
    }
    for (let i = 0; i < count; i++) {
      this.#buf[this.#len + i] = samples[start + i * stride] as number;
    }
    this.#len += count;
    this.#totalIn += count;
  }

  #sampleAt(t: number): number {
    const lo = Math.ceil(t - this.#halfWidth);
    const hi = Math.floor(t + this.#halfWidth);
    const buf = this.#buf;
    const base = this.#base;
    const table = this.#table;
    const ts = this.#tableScale;
    const tableMax = table.length - 2;
    let acc = 0;
    const from = Math.max(lo, base);
    const to = Math.min(hi, base + this.#len - 1);
    for (let n = from; n <= to; n++) {
      const pos = Math.abs(t - n) * ts;
      const i = pos | 0;
      if (i > tableMax) continue;
      const frac = pos - i;
      const k = (table[i] as number) + ((table[i + 1] as number) - (table[i] as number)) * frac;
      acc += (buf[n - base] as number) * k;
    }
    return acc * this.#scale;
  }

  /** Number of outputs computable now (or, with `end`, the remaining outputs of the stream). */
  #available(end: boolean): number {
    if (end) {
      const total = Math.round(this.#totalIn / this.#step);
      return Math.max(0, total - this.#nextOut);
    }
    // Output k needs inputs up to floor(k*step + halfWidth) < totalIn.
    const last = Math.floor((this.#totalIn - 1 - this.#halfWidth) / this.#step);
    return Math.max(0, last + 1 - this.#nextOut);
  }

  /** Feed `count` samples (strided) and write the outputs produced to `out` (strided). */
  process(
    samples: ArrayLike<number>,
    start: number,
    stride: number,
    count: number,
    end: boolean,
  ): Float64Array {
    if (count > 0) this.#append(samples, start, stride, count);
    const n = this.#available(end);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.#sampleAt((this.#nextOut + i) * this.#step);
    }
    this.#nextOut += n;
    if (end) {
      this.clear();
    } else {
      // Drop history no future output can reach.
      const keepFrom = Math.floor(this.#nextOut * this.#step - this.#halfWidth) - 1;
      const drop = Math.min(this.#len, keepFrom - this.#base);
      if (drop > 0) {
        this.#buf.copyWithin(0, drop, this.#len);
        this.#len -= drop;
        this.#base += drop;
      }
    }
    return out;
  }

  clear(): void {
    this.#len = 0;
    this.#base = 0;
    this.#totalIn = 0;
    this.#nextOut = 0;
  }
}

function toInt16(x: number): number {
  const r = Math.round(x);
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}

/** A streaming windowed-sinc resampler over interleaved samples. */
class SincStream implements ResamplerStream {
  readonly #channels: SincChannel[];
  readonly #numChannels: number;
  /** Samples of an incomplete frame carried to the next call. */
  #pending: number[] = [];

  constructor(options: ResamplerStreamOptions) {
    checkRates(options.inRate, options.outRate);
    const numChannels = options.numChannels;
    if (!Number.isInteger(numChannels) || numChannels < 1) {
      throw new Error(`invalid channel count: ${numChannels}`);
    }
    this.#numChannels = numChannels;
    this.#channels = Array.from(
      { length: numChannels },
      () => new SincChannel(options.inRate, options.outRate, options.quality),
    );
  }

  resampleChunk<T extends Int16Array | Float32Array>(chunk: T, last = false): T {
    const c = this.#numChannels;
    let input: ArrayLike<number> = chunk;
    if (this.#pending.length > 0) {
      input = [...this.#pending, ...chunk];
      this.#pending = [];
    }
    const frames = Math.floor(input.length / c);
    const rest = input.length - frames * c;
    if (rest > 0 && !last) {
      this.#pending = Array.from({ length: rest }, (_, i) => input[frames * c + i] as number);
    }
    const outs = this.#channels.map((ch, i) => ch.process(input, i, c, frames, last));
    const outFrames = outs[0]?.length ?? 0;
    const isFloat = chunk instanceof Float32Array;
    const out = isFloat ? new Float32Array(outFrames * c) : new Int16Array(outFrames * c);
    for (let ch = 0; ch < c; ch++) {
      const data = outs[ch] as Float64Array;
      for (let f = 0; f < outFrames; f++) {
        const v = data[f] as number;
        out[f * c + ch] = isFloat ? v : toInt16(v);
      }
    }
    if (last) this.#pending = [];
    return out as T;
  }

  clear(): void {
    this.#pending = [];
    for (const ch of this.#channels) ch.clear();
  }

  destroy(): void {}
}

/**
 * Create the pure-TypeScript windowed-sinc engine.
 *
 * Applications normally never call this: core falls back to it on its own
 * when the WASM engine cannot load. It can also be installed explicitly with
 * `setResamplerEngine(createSincResamplerEngine())`.
 */
export function createSincResamplerEngine(): ResamplerEngine {
  return {
    resample<T extends Int16Array | Float32Array>(
      audio: T,
      inRate: number,
      outRate: number,
      quality: SoxrQuality,
    ): T {
      if (inRate === outRate) return audio;
      const stream = new SincStream({ inRate, outRate, numChannels: 1, quality });
      return stream.resampleChunk(audio, true);
    },
    createStream(options: ResamplerStreamOptions): ResamplerStream {
      return new SincStream(options);
    },
  };
}
