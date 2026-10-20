// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/turn/smart_turn/_whisper_features.py
//
// Portions derived from Hugging Face Transformers
// (src/transformers/models/whisper/feature_extraction_whisper.py and
// src/transformers/audio_utils.py):
//
//   Copyright 2022 The HuggingFace Inc. team.
//   Copyright 2023 The HuggingFace Inc. team and the librosa & torchaudio authors.
//
//   Licensed under the Apache License, Version 2.0
//   (https://www.apache.org/licenses/LICENSE-2.0). Modified by Daily.

/**
 * Dependency-free Whisper-style log-mel feature extraction for Smart Turn v3.
 *
 * Vendored from `transformers.WhisperFeatureExtractor` (upstream uses numpy;
 * this port uses typed arrays) so Smart Turn v3 can compute features without
 * the `transformers` package. The math mirrors
 * `transformers.models.whisper.feature_extraction_whisper` and
 * `transformers.audio_utils` (Apache-2.0 licensed).
 */

const N_FFT = 400;
const HOP_LENGTH = 160;
const N_MELS = 80;
const SAMPLING_RATE = 16000;
const MEL_FLOOR = 1e-10;
const NORM_VARIANCE_EPS = 1e-7;

/** Number of feature frames produced for an 8 second input. */
export const WHISPER_NUM_FRAMES = 800;
/** Number of mel bins per feature frame. */
export const WHISPER_NUM_MELS = N_MELS;

/** Convert a frequency in hertz to mels using the Slaney scale. */
function hertzToMelSlaney(freq: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = 27.0 / Math.log(6.4);
  if (freq >= minLogHertz) {
    return minLogMel + Math.log(freq / minLogHertz) * logstep;
  }
  return (3.0 * freq) / 200.0;
}

/** Convert a frequency in mels to hertz using the Slaney scale. */
function melToHertzSlaney(mels: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = Math.log(6.4) / 27.0;
  if (mels >= minLogMel) {
    return minLogHertz * Math.exp(logstep * (mels - minLogMel));
  }
  return (200.0 * mels) / 3.0;
}

/** numpy.linspace(start, stop, num). */
function linspace(start: number, stop: number, num: number): Float64Array {
  const out = new Float64Array(num);
  const step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i++) out[i] = start + i * step;
  if (num > 1) out[num - 1] = stop;
  return out;
}

/**
 * Build a Slaney-normalized triangular mel filterbank.
 *
 * Returns a row-major matrix of shape `(numFrequencyBins, numMelFilters)`
 * that projects a power spectrogram onto the mel scale.
 */
function buildMelFilterbank(
  numFrequencyBins: number,
  numMelFilters: number,
  minFrequency: number,
  maxFrequency: number,
  samplingRate: number,
): Float64Array {
  const melMin = hertzToMelSlaney(minFrequency);
  const melMax = hertzToMelSlaney(maxFrequency);
  const melFreqs = linspace(melMin, melMax, numMelFilters + 2);
  const filterFreqs = melFreqs.map(melToHertzSlaney);
  const fftFreqs = linspace(0, Math.floor(samplingRate / 2), numFrequencyBins);

  const filters = new Float64Array(numFrequencyBins * numMelFilters);
  for (let k = 0; k < numFrequencyBins; k++) {
    for (let m = 0; m < numMelFilters; m++) {
      const f = fftFreqs[k] as number;
      const lower = filterFreqs[m] as number;
      const center = filterFreqs[m + 1] as number;
      const upper = filterFreqs[m + 2] as number;
      const downSlope = -(lower - f) / (center - lower);
      const upSlope = (upper - f) / (upper - center);
      let value = Math.max(0, Math.min(downSlope, upSlope));
      // Slaney area normalization.
      value *= 2.0 / (upper - lower);
      filters[k * numMelFilters + m] = value;
    }
  }
  return filters;
}

/** Return a periodic Hann window (matches torch.hann_window). */
function periodicHannWindow(windowLength: number): Float64Array {
  const out = new Float64Array(windowLength);
  for (let n = 0; n < windowLength; n++) {
    out[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / windowLength);
  }
  return out;
}

// Precomputed constants for the Whisper feature extractor defaults used by
// Smart Turn v3.
const HANN_WINDOW = periodicHannWindow(N_FFT);
const NUM_FREQUENCY_BINS = Math.floor(N_FFT / 2) + 1;
const MEL_FILTERS = buildMelFilterbank(
  NUM_FREQUENCY_BINS,
  N_MELS,
  0.0,
  SAMPLING_RATE / 2.0,
  SAMPLING_RATE,
);
const COS_TABLE = new Float64Array(N_FFT);
const SIN_TABLE = new Float64Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  COS_TABLE[i] = Math.cos((2 * Math.PI * i) / N_FFT);
  SIN_TABLE[i] = Math.sin((2 * Math.PI * i) / N_FFT);
}

/**
 * Compute a centered power spectrogram (reflect-padded, real DFT, |.|^2).
 *
 * Returns a row-major Float64Array of shape `(numFrequencyBins, numFrames)`.
 */
function powerSpectrogram(
  waveform: Float32Array,
  window: Float64Array,
  frameLength: number,
  hopLength: number,
): { data: Float64Array; numFrames: number } {
  const pad = Math.floor(frameLength / 2);
  const n = waveform.length;
  // Reflect padding (numpy mode="reflect": the edge sample is not repeated).
  const padded = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = waveform[i + 1] as number;
    padded[pad + n + i] = waveform[n - 2 - i] as number;
  }
  for (let i = 0; i < n; i++) padded[pad + i] = waveform[i] as number;

  const numFrames = Math.floor((padded.length - frameLength) / hopLength) + 1;
  const numBins = Math.floor(frameLength / 2) + 1;
  const out = new Float64Array(numBins * numFrames);
  const frame = new Float64Array(frameLength);

  for (let t = 0; t < numFrames; t++) {
    const start = t * hopLength;
    for (let i = 0; i < frameLength; i++) {
      frame[i] = (padded[start + i] as number) * (window[i] as number);
    }
    for (let k = 0; k < numBins; k++) {
      let re = 0;
      let im = 0;
      let idx = 0;
      for (let i = 0; i < frameLength; i++) {
        const v = frame[i] as number;
        re += v * (COS_TABLE[idx] as number);
        im -= v * (SIN_TABLE[idx] as number);
        idx += k;
        if (idx >= frameLength) idx -= frameLength;
      }
      out[k * numFrames + t] = re * re + im * im;
    }
  }
  return { data: out, numFrames };
}

export interface ComputeWhisperLogMelFeaturesOptions {
  /**
   * If true, apply zero-mean unit-variance normalization to the waveform
   * before computing the spectrogram. Matches the transformers
   * `do_normalize=True` behavior. Defaults to true.
   */
  doNormalize?: boolean;
}

/**
 * Compute Whisper-style log-mel features for Smart Turn v3.
 *
 * Replicates the output of
 * `transformers.WhisperFeatureExtractor(chunk_length=8)(audio, sampling_rate=16000,
 * padding="max_length", max_length=128000, truncation=True, do_normalize=...,
 * return_tensors="np").input_features.squeeze(0)`.
 *
 * Assumes the caller has already padded or truncated the input to exactly
 * 128000 samples (8 seconds at 16 kHz); shorter inputs are zero-padded at the
 * end, longer inputs are truncated to the leading window.
 *
 * @param audio One-dimensional float audio at 16 kHz.
 * @returns Float32Array holding a row-major `(80, 800)` matrix of log-mel
 *   features in roughly the `[-1, 1]` range.
 */
export function computeWhisperLogMelFeatures(
  audio: Float32Array | ArrayLike<number>,
  options: ComputeWhisperLogMelFeaturesOptions = {},
): Float32Array {
  const doNormalize = options.doNormalize ?? true;

  const nSamples = SAMPLING_RATE * 8; // 128000
  let x = new Float32Array(nSamples);
  const len = Math.min(audio.length, nSamples);
  for (let i = 0; i < len; i++) x[i] = audio[i] as number;

  // Zero-mean unit-variance waveform normalization happens BEFORE the
  // spectrogram, mirroring transformers' WhisperFeatureExtractor.__call__.
  // Done in float32 to match the reference's precision (it normalizes the
  // padded float32 buffer before the spectrogram promotes to float64).
  if (doNormalize) {
    let sum = 0;
    for (let i = 0; i < nSamples; i++) sum += x[i] as number;
    const mean = Math.fround(sum / nSamples);
    let sq = 0;
    for (let i = 0; i < nSamples; i++) {
      const d = (x[i] as number) - mean;
      sq += d * d;
    }
    const variance = Math.fround(sq / nSamples);
    const denom = Math.fround(Math.sqrt(Math.fround(variance + NORM_VARIANCE_EPS)));
    const normalized = new Float32Array(nSamples);
    for (let i = 0; i < nSamples; i++) {
      normalized[i] = Math.fround((x[i] as number) - mean) / denom;
    }
    x = normalized;
  }

  const { data: magnitudes, numFrames } = powerSpectrogram(x, HANN_WINDOW, N_FFT, HOP_LENGTH);

  // mel_spec = max(MEL_FLOOR, MEL_FILTERS.T @ magnitudes), then log10; the
  // trailing frame is dropped, matching the reference.
  const outFrames = numFrames - 1;
  const logSpec = new Float64Array(N_MELS * outFrames);
  let maxValue = Number.NEGATIVE_INFINITY;
  for (let m = 0; m < N_MELS; m++) {
    for (let t = 0; t < outFrames; t++) {
      let acc = 0;
      for (let k = 0; k < NUM_FREQUENCY_BINS; k++) {
        acc += (MEL_FILTERS[k * N_MELS + m] as number) * (magnitudes[k * numFrames + t] as number);
      }
      const value = Math.log10(Math.max(MEL_FLOOR, acc));
      logSpec[m * outFrames + t] = value;
      if (value > maxValue) maxValue = value;
    }
  }

  const floor = maxValue - 8.0;
  const out = new Float32Array(N_MELS * outFrames);
  for (let i = 0; i < out.length; i++) {
    out[i] = (Math.max(logSpec[i] as number, floor) + 4.0) / 4.0;
  }
  return out;
}
