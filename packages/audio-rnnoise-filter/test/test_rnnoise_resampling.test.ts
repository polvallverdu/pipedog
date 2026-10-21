// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rnnoise_resampling.py

import { describe, expect, test } from "bun:test";
import { FilterEnableFrame } from "@pipedog/core/frames/frames";
import { RNNoiseFilter, type RNNoiseLike } from "../src/index.ts";
import { bytesOf, concat, int16Of, linspace } from "./helpers.ts";

describe("TestRNNoiseResampling", () => {
  test("test_rnnoise_resampling_16k_to_48k_and_back", async () => {
    // Configure the fake RNNoise with buffering behavior
    let processedChunksCount = 0;
    let buffer = new Int16Array(0);

    const mockRnnoise: RNNoiseLike = {
      *denoiseChunk(audioSamples: Int16Array) {
        // Append new samples to buffer
        if (audioSamples.length > 0) {
          const next = new Int16Array(buffer.length + audioSamples.length);
          next.set(buffer);
          next.set(audioSamples, buffer.length);
          buffer = next;
        }

        // Yield 480-sample chunks
        while (buffer.length >= 480) {
          const chunk = buffer.slice(0, 480);
          buffer = buffer.slice(480);
          processedChunksCount += 1;

          // Simulate processing (pass through)
          // Convert int16 -> float32 [-1, 1]
          yield [0.99, Float32Array.from(chunk, (v) => v / 32768.0)] as [number, Float32Array];
        }
      },
    };

    // 1. Generate 1 second of 16kHz audio (sine wave 440Hz)
    const sampleRate = 16000;
    const duration = 1.0;
    const t = linspace(0, duration, Math.trunc(sampleRate * duration), false);
    const audioData = Int16Array.from(t, (ti) =>
      Math.trunc(Math.sin(2 * Math.PI * 440 * ti) * 32767),
    );
    const audioBytes = bytesOf(audioData);

    // 2. Initialize RNNoiseFilter (with the fake RNNoise)
    const rnnoiseFilter = new RNNoiseFilter({ rnnoise: () => mockRnnoise });
    await rnnoiseFilter.start(sampleRate);

    // Enable filtering
    await rnnoiseFilter.processFrame(new FilterEnableFrame({ enable: true }));

    // 3. Process audio in chunks
    const chunkSize = 320; // 160 samples (10ms at 16k) * 2 bytes
    const parts: Uint8Array[] = [];
    for (let i = 0; i < audioBytes.length; i += chunkSize) {
      parts.push(await rnnoiseFilter.filter(audioBytes.slice(i, i + chunkSize)));
    }
    const processedAudio = concat(parts);

    await rnnoiseFilter.stop();

    // 4. Verify output length
    // Expect roughly same length
    const expectedChunks = Math.floor(Math.floor((audioData.length * 48000) / sampleRate) / 480);

    // Check that we actually processed something
    expect(processedChunksCount).toBeGreaterThanOrEqual(expectedChunks - 5);

    // Check output length
    expect(processedAudio.length).toBeGreaterThan(0);

    // Check length matches input (with some tolerance for buffering latency)
    const byteTolerance = Math.trunc(0.2 * sampleRate * 2);
    expect(processedAudio.length).toBeGreaterThanOrEqual(audioBytes.length - byteTolerance);
    expect(processedAudio.length).toBeLessThanOrEqual(audioBytes.length + byteTolerance);

    // 5. Check sample rate / pitch preservation
    const outputData = int16Of(processedAudio);

    if (outputData.length > 2000) {
      // Use a window in the middle
      const startIdx = Math.floor(outputData.length / 4);
      const endIdx = Math.floor((3 * outputData.length) / 4);
      const segment = outputData.slice(startIdx, endIdx);

      // Peak frequency via a DFT scan over 300..600 Hz (np.fft.rfft + argmax in upstream).
      let peakFreq = 0;
      let peakMag = -1;
      for (let f = 300; f <= 600; f += 1) {
        let re = 0;
        let im = 0;
        for (let n = 0; n < segment.length; n += 1) {
          const ang = (2 * Math.PI * f * n) / sampleRate;
          re += (segment[n] as number) * Math.cos(ang);
          im -= (segment[n] as number) * Math.sin(ang);
        }
        const mag = Math.hypot(re, im);
        if (mag > peakMag) {
          peakMag = mag;
          peakFreq = f;
        }
      }
      expect(Math.abs(peakFreq - 440)).toBeLessThan(50);
    }
  });
});
