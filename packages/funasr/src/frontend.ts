// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * SenseVoice's speech front end: Kaldi-compatible log-mel filterbank, low
 * frame rate stacking (LFR) and CMVN, as FunASR's `WavFrontend` computes them.
 *
 * FunASR runs `torchaudio.compliance.kaldi.fbank` (or kaldi-native-fbank) with
 * SenseVoiceSmall's `frontend_conf`: 16 kHz, 80 mel bins, 25 ms frames with a
 * 10 ms shift, a Hamming window, `snip_edges`, pre-emphasis 0.97, DC offset
 * removal, power spectrum over a 512-point FFT, mel bins from 20 Hz to
 * Nyquist, natural log floored at float32 epsilon. Samples are scaled to the
 * int16 range first (`upsacle_samples`). Then `apply_lfr` stacks 7 frames every
 * 6 (left-padded with 3 copies of the first frame, right-padded with the last)
 * and `apply_cmvn` adds the negated means and multiplies by the inverse
 * standard deviations from `am.mvn`.
 *
 * FunASR's `WavFrontend` defaults to `dither=1.0` (Gaussian noise with a
 * standard deviation of one int16 step); this front end uses no dither, as
 * sherpa-onnx and FunASR's ONNX runtime do, so results are deterministic.
 */

/** Front-end configuration (defaults: SenseVoiceSmall's). */
export interface FbankOptions {
  sampleRate?: number;
  numMelBins?: number;
  frameLengthMs?: number;
  frameShiftMs?: number;
  preemphasis?: number;
  lowFreq?: number;
  highFreq?: number;
  removeDcOffset?: boolean;
}

const FLT_EPSILON = 1.1920928955078125e-7;

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function melScale(freq: number): number {
  return 1127.0 * Math.log(1.0 + freq / 700.0);
}

interface MelBank {
  /** First FFT bin with a non-zero weight. */
  start: number;
  weights: Float64Array;
}

const melBankCache = new Map<string, MelBank[]>();

/** torchaudio's `get_mel_banks` (no VTLN), stored sparsely. */
function melBanks(
  numBins: number,
  paddedWindow: number,
  sampleRate: number,
  lowFreq: number,
  highFreq: number,
): MelBank[] {
  const key = `${numBins}/${paddedWindow}/${sampleRate}/${lowFreq}/${highFreq}`;
  const cached = melBankCache.get(key);
  if (cached) return cached;
  const numFftBins = paddedWindow / 2;
  const nyquist = 0.5 * sampleRate;
  const high = highFreq <= 0 ? highFreq + nyquist : highFreq;
  const fftBinWidth = sampleRate / paddedWindow;
  const melLow = melScale(lowFreq);
  const melHigh = melScale(high);
  const delta = (melHigh - melLow) / (numBins + 1);
  const banks: MelBank[] = [];
  for (let b = 0; b < numBins; b++) {
    const left = melLow + b * delta;
    const center = melLow + (b + 1) * delta;
    const right = melLow + (b + 2) * delta;
    const full = new Float64Array(numFftBins);
    let start = -1;
    let end = -1;
    for (let k = 0; k < numFftBins; k++) {
      const mel = melScale(fftBinWidth * k);
      const up = (mel - left) / (center - left);
      const down = (right - mel) / (right - center);
      const w = Math.max(0, Math.min(up, down));
      full[k] = w;
      if (w > 0) {
        if (start < 0) start = k;
        end = k;
      }
    }
    banks.push(
      start < 0
        ? { start: 0, weights: new Float64Array(0) }
        : { start, weights: full.slice(start, end + 1) },
    );
  }
  melBankCache.set(key, banks);
  return banks;
}

const fftCache = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();

function fftTables(n: number) {
  let t = fftCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    t = { cos, sin, rev };
    fftCache.set(n, t);
  }
  return t;
}

/** In-place radix-2 complex FFT (n a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  const { cos, sin, rev } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i]!;
    if (j > i) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

/** A matrix of `rows` × `cols` float32 values, row-major. */
export interface FeatureMatrix {
  data: Float32Array;
  rows: number;
  cols: number;
}

/**
 * Kaldi-compatible log-mel filterbank (`torchaudio.compliance.kaldi.fbank`
 * with a Hamming window, `snip_edges`, no dither, `use_power`, `use_log_fbank`).
 *
 * @param waveform Samples in the int16 range (not normalized to [-1, 1]).
 */
export function kaldiFbank(waveform: Float32Array, options: FbankOptions = {}): FeatureMatrix {
  const sampleRate = options.sampleRate ?? 16000;
  const numMelBins = options.numMelBins ?? 80;
  const frameLengthMs = options.frameLengthMs ?? 25;
  const frameShiftMs = options.frameShiftMs ?? 10;
  const preemph = options.preemphasis ?? 0.97;
  const removeDc = options.removeDcOffset ?? true;

  const windowShift = Math.trunc(sampleRate * frameShiftMs * 0.001);
  const windowSize = Math.trunc(sampleRate * frameLengthMs * 0.001);
  const n = waveform.length;
  // snip_edges: only frames that fit entirely.
  const numFrames =
    windowSize <= 0 || n < windowSize ? 0 : 1 + Math.floor((n - windowSize) / windowShift);
  const out = new Float32Array(numFrames * numMelBins);
  if (numFrames === 0) return { data: out, rows: 0, cols: numMelBins };

  const padded = nextPowerOfTwo(windowSize);
  const banks = melBanks(
    numMelBins,
    padded,
    sampleRate,
    options.lowFreq ?? 20,
    options.highFreq ?? 0,
  );
  // torch.hamming_window(windowSize, periodic=False)
  const window = new Float64Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    window[i] = windowSize === 1 ? 1 : 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (windowSize - 1));
  }
  const frame = new Float64Array(windowSize);
  const re = new Float64Array(padded);
  const im = new Float64Array(padded);
  const power = new Float64Array(padded / 2 + 1);

  for (let f = 0; f < numFrames; f++) {
    const offset = f * windowShift;
    let mean = 0;
    for (let i = 0; i < windowSize; i++) {
      const v = waveform[offset + i]!;
      frame[i] = v;
      mean += v;
    }
    if (removeDc) {
      mean /= windowSize;
      for (let i = 0; i < windowSize; i++) frame[i] = frame[i]! - mean;
    }
    re.fill(0);
    im.fill(0);
    // Pre-emphasis with the first sample replicated: x[i] - c * x[i - 1].
    for (let i = windowSize - 1; i >= 0; i--) {
      const prev = i > 0 ? frame[i - 1]! : frame[0]!;
      re[i] = (frame[i]! - preemph * prev) * window[i]!;
    }
    fft(re, im);
    for (let k = 0; k <= padded / 2; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    const row = f * numMelBins;
    for (let b = 0; b < numMelBins; b++) {
      const { start, weights } = banks[b]!;
      let energy = 0;
      for (let k = 0; k < weights.length; k++) energy += power[start + k]! * weights[k]!;
      out[row + b] = Math.log(Math.max(energy, FLT_EPSILON));
    }
  }
  return { data: out, rows: numFrames, cols: numMelBins };
}

/**
 * FunASR's `apply_lfr`: stack `m` consecutive frames every `n` frames, with
 * `(m - 1) / 2` copies of the first frame in front and the last frame repeated
 * past the end. Output has `ceil(T / n)` rows of `m * dim` values.
 */
export function applyLfr(feats: FeatureMatrix, m: number, n: number): FeatureMatrix {
  const { rows: t, cols: dim, data } = feats;
  const outRows = Math.ceil(t / n);
  const outCols = m * dim;
  const out = new Float32Array(outRows * outCols);
  if (t === 0) return { data: out, rows: 0, cols: outCols };
  const leftPad = Math.floor((m - 1) / 2);
  const paddedRows = t + leftPad;
  for (let i = 0; i < outRows; i++) {
    for (let j = 0; j < m; j++) {
      // Row in the left-padded sequence, clamped to its last row.
      const p = Math.min(i * n + j, paddedRows - 1);
      const src = Math.max(0, p - leftPad);
      out.set(data.subarray(src * dim, (src + 1) * dim), i * outCols + j * dim);
    }
  }
  return { data: out, rows: outRows, cols: outCols };
}

/** FunASR's `apply_cmvn`: `(x + negMean) * invStddev`, per dimension, in place. */
export function applyCmvn(
  feats: FeatureMatrix,
  negMean: Float32Array,
  invStddev: Float32Array,
): FeatureMatrix {
  const { rows, cols, data } = feats;
  const dims = Math.min(cols, negMean.length, invStddev.length);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let d = 0; d < dims; d++) {
      data[base + d] = Math.fround((data[base + d]! + negMean[d]!) * invStddev[d]!);
    }
  }
  return feats;
}

/** Front-end parameters for SenseVoice. */
export interface SenseVoiceFrontendConfig {
  lfrM: number;
  lfrN: number;
  negMean: Float32Array;
  invStddev: Float32Array;
  sampleRate?: number;
}

/**
 * SenseVoice features from float samples in [-1, 1]: scale to the int16 range,
 * filterbank, LFR, CMVN. Like FunASR's `WavFrontend.forward`, a clip shorter
 * than one 25 ms frame uses a single frame as long as the clip.
 */
export function senseVoiceFeatures(
  audio: Float32Array,
  config: SenseVoiceFrontendConfig,
): FeatureMatrix {
  const sampleRate = config.sampleRate ?? 16000;
  const scaled = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) scaled[i] = audio[i]! * 32768;
  const frameLengthMs = Math.min(25, (audio.length / sampleRate) * 1000);
  const fbank = kaldiFbank(scaled, { sampleRate, frameLengthMs });
  const lfr = applyLfr(fbank, config.lfrM, config.lfrN);
  return applyCmvn(lfr, config.negMean, config.invStddev);
}
