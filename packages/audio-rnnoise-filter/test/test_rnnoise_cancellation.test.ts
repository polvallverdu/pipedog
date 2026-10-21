// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rnnoise_cancellation.py

import { describe, expect, test } from "bun:test";
import { FilterEnableFrame } from "@pipedog/core/frames/frames";
import { RNNoiseFilter } from "../src/index.ts";
import { bytesOf, concat, int16Of, linspace, rng } from "./helpers.ts";

const mean = (xs: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i] as number;
  return s / xs.length;
};

describe("TestRNNoiseCancellation", () => {
  test("test_rnnoise_cancellation_functionality", async () => {
    // 2. Generate clean speech-like audio (Harmonic series)
    const sampleRate = 48000;
    const duration = 2.0;
    const t = linspace(0, duration, Math.trunc(sampleRate * duration), true);
    const random = rng(7);

    // Fundamental 200Hz + harmonics, with an envelope to simulate speech (bursts):
    // sin(2*pi*2*t) has period 0.5s.
    const cleanSignal = t.map((ti) => {
      const harmonics =
        Math.sin(2 * Math.PI * 200 * ti) * 0.5 +
        Math.sin(2 * Math.PI * 400 * ti) * 0.3 +
        Math.sin(2 * Math.PI * 600 * ti) * 0.2;
      const envelope = Math.min(Math.max(Math.sin(2 * Math.PI * 2 * ti), 0), 1);
      return harmonics * envelope;
    });

    // 3. Add Noise (White Noise)
    const noiseLevel = 0.1;
    const noisySignal = cleanSignal.map((c) => c + random.normal(0, noiseLevel));

    // Normalize to int16 range
    const noisyInt16 = Int16Array.from(noisySignal, (v) =>
      Math.trunc(Math.min(Math.max(v, -1), 1) * 32767),
    );
    const noisyBytes = bytesOf(noisyInt16);
    const cleanInt16 = Int16Array.from(cleanSignal, (v) => Math.trunc(v * 32767));

    // 4. Initialize RNNoiseFilter
    const rnnoiseFilter = new RNNoiseFilter();
    await rnnoiseFilter.start(sampleRate);
    await rnnoiseFilter.processFrame(new FilterEnableFrame({ enable: true }));

    // 5. Process: feed in chunks
    const chunkSize = 960; // 20ms
    const parts: Uint8Array[] = [];
    for (let i = 0; i < noisyBytes.length; i += chunkSize) {
      parts.push(await rnnoiseFilter.filter(noisyBytes.slice(i, i + chunkSize)));
    }
    const processedAudio = concat(parts);
    await rnnoiseFilter.stop();

    // 6. Verify Noise Reduction
    const outputInt16 = int16Of(processedAudio);

    // Truncate to min length
    const minLen = Math.min(cleanInt16.length, outputInt16.length);
    const cleanTrunc = cleanInt16.subarray(0, minLen);
    const outputTrunc = outputInt16.subarray(0, minLen);
    const noisyTrunc = noisyInt16.subarray(0, minLen);

    // 7. Compensate for Delay: cross-correlation on a segment to find the delay.
    // We expect output to be delayed relative to clean (lag is positive).
    const searchRange = 2400; // 50ms
    const midPoint = Math.floor(minLen / 2);
    const windowLen = 4800; // 100ms

    const refSig = cleanTrunc.subarray(midPoint, midPoint + windowLen);
    const target = outputTrunc.subarray(midPoint - searchRange, midPoint + windowLen + searchRange);
    // np.correlate(target, ref, mode="valid"): one value per shift.
    let bestIdx = 0;
    let bestCorr = Number.NEGATIVE_INFINITY;
    const shifts = target.length - refSig.length + 1;
    for (let s = 0; s < shifts; s++) {
      let acc = 0;
      for (let k = 0; k < refSig.length; k++) {
        acc += (target[s + k] as number) * (refSig[k] as number);
      }
      if (acc > bestCorr) {
        bestCorr = acc;
        bestIdx = s;
      }
    }
    const delay = bestIdx - searchRange;

    // Shift output to align
    let alignedOutput: Int16Array;
    let alignedClean: Int16Array;
    let alignedNoisy: Int16Array;
    if (delay > 0) {
      alignedOutput = outputTrunc.subarray(delay);
      alignedClean = cleanTrunc.subarray(0, alignedOutput.length);
      alignedNoisy = noisyTrunc.subarray(0, alignedOutput.length);
    } else if (delay < 0) {
      alignedOutput = outputTrunc.subarray(0, delay);
      alignedClean = cleanTrunc.subarray(-delay);
      alignedNoisy = noisyTrunc.subarray(-delay);
    } else {
      alignedOutput = outputTrunc;
      alignedClean = cleanTrunc;
      alignedNoisy = noisyTrunc;
    }

    // Recalculate MSE on aligned signals
    const sq = (a: Int16Array, b: Int16Array) =>
      mean(Float64Array.from(a, (v, i) => (v - (b[i] as number)) ** 2));
    const mseInput = sq(alignedNoisy, alignedClean);
    const mseOutput = sq(alignedOutput, alignedClean);

    // Also check noise reduction in silent regions (where the clean signal is tiny)
    const threshold = 100; // amplitude threshold (out of 32767)
    const silentIdx: number[] = [];
    for (let i = 0; i < alignedClean.length; i++) {
      if (Math.abs(alignedClean[i] as number) < threshold) silentIdx.push(i);
    }
    const silentPower = (a: Int16Array) => mean(silentIdx.map((i) => (a[i] as number) ** 2));

    if (silentIdx.length > 1000) {
      const noisePowerInput = silentPower(alignedNoisy);
      const noisePowerOutput = silentPower(alignedOutput);
      expect(noisePowerOutput).toBeLessThan(noisePowerInput); // Noise power in silence not reduced
    }

    // Main assertion: MSE should improve. Relaxed as upstream: RNNoise distorts
    // speech, so if the MSE did not improve the noise power in silence must have dropped.
    if (mseOutput >= mseInput) {
      expect(
        silentIdx.length > 1000 && silentPower(alignedOutput) < silentPower(alignedNoisy),
      ).toBe(true);
    } else {
      expect(mseOutput).toBeLessThan(mseInput);
    }
  });
});
