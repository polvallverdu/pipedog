// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rnnoise_filter.py

import { describe, expect, test } from "bun:test";
import { FilterEnableFrame } from "@pipedog/core/frames/frames";
import { RNNoiseFilter } from "../src/index.ts";
import { bytesOf, int16Of, linspace, randomInt16, rng } from "./helpers.ts";

describe("TestRNNoiseFilter", () => {
  test("test_rnnoise_filter_reduces_noise", async () => {
    // Test that RNNoise filter reduces noise in audio.
    const filter = new RNNoiseFilter();

    // Initialize with 48kHz sample rate (RNNoise requirement)
    await filter.start(48000);

    // Create noisy audio: clean signal + noise
    // Need at least 480 samples (one frame) for processing
    const duration = 0.02; // 20ms = 960 samples at 48kHz (2 frames)
    const sampleRate = 48000;
    const random = rng();
    const t = linspace(0, duration, Math.trunc(sampleRate * duration), false);
    const frequency = 440.0; // A4 note
    const noisy = Int16Array.from(t, (ti) => {
      const v = Math.sin(2 * Math.PI * frequency * ti) + random.normal(0, 0.3);
      return Math.trunc(v * 32767);
    });

    // Process through filter
    const filteredAudioBytes = await filter.filter(bytesOf(noisy));

    // Convert back to an array for comparison
    const filteredAudio = int16Of(filteredAudioBytes);

    // Verify output is not empty (should have at least one processed frame)
    expect(filteredAudio.length).toBeGreaterThan(0);
    expect(filteredAudioBytes).not.toBeNull();

    await filter.stop();
  });

  test("test_rnnoise_filter_passthrough_when_disabled", async () => {
    // Test that RNNoise filter passes through audio when disabled.
    const filter = new RNNoiseFilter();
    await filter.start(48000);

    // Disable filtering
    await filter.processFrame(new FilterEnableFrame({ enable: false }));

    // Create test audio
    const testAudio = bytesOf(randomInt16(480, rng()));

    // Process through filter
    const filteredAudio = await filter.filter(testAudio);

    // Should pass through unchanged when disabled
    expect(filteredAudio).toEqual(testAudio);

    await filter.stop();
  });

  test("test_rnnoise_filter_buffering", async () => {
    // Test that RNNoise filter properly buffers incomplete frames.
    const filter = new RNNoiseFilter();
    await filter.start(48000);
    const random = rng();

    // Send a small chunk that's less than a full frame (480 samples)
    const smallChunk = bytesOf(randomInt16(100, random));

    // First call should return empty (buffering, not enough for a frame)
    const result1 = await filter.filter(smallChunk);
    expect(result1).toEqual(new Uint8Array(0));

    // Send more data to complete a frame (100 + 500 = 600 samples > 480)
    const moreData = bytesOf(randomInt16(500, random));
    const result2 = await filter.filter(moreData);

    // Should return processed audio for at least one complete frame
    expect(result2.length).toBeGreaterThan(0);

    await filter.stop();
  });

  test("test_rnnoise_filter_handles_empty_resampler_output", async () => {
    // Test that RNNoise filter handles empty bytes from resampler gracefully.
    //
    // This reproduces the issue where mute/silence input (like "bx000") causes
    // the resampler to return empty bytes. The filter should handle this gracefully
    // without raising a memory error.
    const filter = new RNNoiseFilter();

    // Initialize with a sample rate that requires resampling (not 48kHz)
    await filter.start(16000);

    // Enable filtering
    await filter.processFrame(new FilterEnableFrame({ enable: true }));

    // Create mute/silence audio chunk (like "bx000" - all zeros)
    const muteAudio = new Uint8Array(2 * 160); // 160 samples of silence at 16kHz (10ms)

    // Mock the resampler to return empty bytes when given mute input
    // This simulates the real-world scenario where resampler returns b"" for mute sounds
    const mockResample = async (audio: Uint8Array, _inRate: number, _outRate: number) => {
      // If input is all zeros (mute), return empty bytes
      if (audio.length === 0 || audio.every((b) => b === 0)) {
        return new Uint8Array(0); // Return empty bytes - this triggers the bug
      }
      // Otherwise, do normal resampling
      return audio;
    };
    (filter as any)._resamplerIn.resample = mockResample;

    const result = await filter.filter(muteAudio);

    // When resampler returns empty bytes, filter should return empty bytes
    // (or handle it gracefully without crashing)
    expect(result).toEqual(new Uint8Array(0));

    await filter.stop();
  });
});
