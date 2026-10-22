// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Silence trimming: `librosa.effects.trim()` with its defaults, as vendored
 * by kokoro-onnx (`kokoro_onnx/trim.py`).
 *
 * The signal is split into 2048-sample frames every 512 samples (centered,
 * zero-padded), and frames whose RMS is more than `topDb` below the loudest
 * frame's count as silence. Leading and trailing silent frames are cut.
 */

export interface TrimOptions {
  /** Threshold below the loudest frame, in dB (default 60). */
  topDb?: number;
  /** Samples per analysis frame (default 2048). */
  frameLength?: number;
  /** Samples between frames (default 512). */
  hopLength?: number;
}

/**
 * Trim leading and trailing silence from `y`.
 *
 * @returns The trimmed signal (a view of `y`) and the kept interval `[start, end)`.
 */
export function trim(y: Float32Array, options: TrimOptions = {}): [Float32Array, [number, number]] {
  const topDb = options.topDb ?? 60;
  const frameLength = options.frameLength ?? 2048;
  const hopLength = options.hopLength ?? 512;
  const n = y.length;
  const pad = Math.floor(frameLength / 2);
  const padded = n + 2 * pad;
  if (padded < frameLength) return [y.subarray(0, 0), [0, 0]];

  // Prefix sums of squares over the zero-padded signal.
  const prefix = new Float64Array(padded + 1);
  for (let i = 0; i < padded; i++) {
    const j = i - pad;
    const v = j >= 0 && j < n ? (y[j] as number) : 0;
    prefix[i + 1] = (prefix[i] as number) + v * v;
  }
  const frames = 1 + Math.floor((padded - frameLength) / hopLength);
  const rms = new Float64Array(frames);
  let maxRms = 0;
  for (let f = 0; f < frames; f++) {
    const a = f * hopLength;
    const power = ((prefix[a + frameLength] as number) - (prefix[a] as number)) / frameLength;
    const r = Math.sqrt(Math.max(0, power));
    rms[f] = r;
    if (r > maxRms) maxRms = r;
  }

  // amplitude_to_db(rms, ref=max) = power_to_db(rms**2, ref=max**2, amin=1e-10).
  const refDb = 10 * Math.log10(Math.max(1e-10, maxRms * maxRms));
  let first = -1;
  let last = -1;
  for (let f = 0; f < frames; f++) {
    const r = rms[f] as number;
    const db = 10 * Math.log10(Math.max(1e-10, r * r)) - refDb;
    if (db > -topDb) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return [y.subarray(0, 0), [0, 0]];
  const start = first * hopLength;
  const end = Math.min(n, (last + 1) * hopLength);
  return [y.subarray(start, end), [start, end]];
}
