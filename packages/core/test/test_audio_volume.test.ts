// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_audio_volume.py

import { describe, expect, mock, test } from "bun:test";

import * as audioUtils from "../src/audio/utils.ts";
import { AudioVolumeTracker, VOLUME_WINDOW_SECS } from "../src/audio/volume.ts";

const SAMPLE_RATE = 16000;
const CHUNK_NUM_BYTES = 320 * 2; // 20ms

/** Seeded PRNG (mulberry32), standing in for `np.random.default_rng(seed)`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate mono 16-bit noise of the given amplitude. */
function audio(numSamples: number, amplitude: number, seed = 0): Uint8Array {
  const rand = mulberry32(seed);
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    // Box-Muller transform for a normal distribution.
    const u1 = 1 - rand();
    const u2 = rand();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    // Int16Array assignment wraps like numpy's astype(np.int16) after truncation.
    samples[i] = Math.trunc(n * amplitude);
  }
  return new Uint8Array(samples.buffer);
}

function windowNumBytes(sampleRate: number = SAMPLE_RATE): number {
  return Math.ceil(VOLUME_WINDOW_SECS * sampleRate) * 2;
}

/** Feed audio in 20ms chunks and return the volume after each one. */
function feed(
  tracker: AudioVolumeTracker,
  data: Uint8Array,
  sampleRate: number = SAMPLE_RATE,
): number[] {
  const volumes: number[] = [];
  for (let i = 0; i < data.length; i += CHUNK_NUM_BYTES) {
    tracker.update(data.subarray(i, i + CHUNK_NUM_BYTES), sampleRate);
    volumes.push(tracker.volume);
  }
  return volumes;
}

/** Access to the protected rolling window, like Python's `tracker._buffer`. */
function bufferOf(tracker: AudioVolumeTracker): Uint8Array {
  return (tracker as unknown as { _buffer: Uint8Array })._buffer;
}

describe("TestAudioVolumeTracker", () => {
  test("test_volume_is_zero_until_window_fills", () => {
    const tracker = new AudioVolumeTracker();
    const windowSamples = Math.ceil(VOLUME_WINDOW_SECS * SAMPLE_RATE);

    // One chunk short of a full window.
    const volumes = feed(tracker, audio(windowSamples - 320, 8000));
    expect(volumes.every((v) => v === 0.0)).toBe(true);
    expect(tracker.volume).toEqual(0.0);

    // The chunk that completes the window produces a measurement.
    tracker.update(audio(320, 8000), SAMPLE_RATE);
    expect(tracker.volume).toBeGreaterThan(0.0);
  });

  test("test_loud_audio_reads_louder_than_quiet_audio", () => {
    const loud = new AudioVolumeTracker();
    const quiet = new AudioVolumeTracker();
    const numSamples = SAMPLE_RATE; // 1s, comfortably longer than the window

    feed(loud, audio(numSamples, 8000));
    feed(quiet, audio(numSamples, 50));

    expect(loud.volume).toBeGreaterThan(quiet.volume);
    expect(loud.volume).toBeGreaterThanOrEqual(0.0);
    expect(loud.volume).toBeLessThanOrEqual(1.0);
  });

  test("test_silence_reads_zero", () => {
    const tracker = new AudioVolumeTracker();
    feed(tracker, new Uint8Array(2 * SAMPLE_RATE));
    expect(tracker.volume).toEqual(0.0);
  });

  test("test_window_is_bounded", () => {
    const tracker = new AudioVolumeTracker();
    feed(tracker, audio(SAMPLE_RATE * 5, 8000));
    expect(bufferOf(tracker).length).toEqual(windowNumBytes());
  });

  test("test_chunk_larger_than_window", () => {
    const tracker = new AudioVolumeTracker();
    tracker.update(audio(SAMPLE_RATE * 3, 8000), SAMPLE_RATE);
    expect(tracker.volume).toBeGreaterThan(0.0);
    expect(bufferOf(tracker).length).toEqual(windowNumBytes());
  });

  test("test_volume_is_measured_once_per_update", () => {
    const tracker = new AudioVolumeTracker();
    tracker.update(audio(SAMPLE_RATE, 8000), SAMPLE_RATE);

    // Equivalent of patch("pipecat.audio.volume.calculate_audio_volume", return_value=0.5).
    const original = { ...audioUtils };
    const measure = mock((_audio: Uint8Array, _sampleRate: number) => 0.5);
    mock.module("../src/audio/utils.ts", () => ({ ...original, calculateAudioVolume: measure }));
    try {
      expect(tracker.volume).toEqual(0.5);
      expect(tracker.volume).toEqual(0.5);
      expect(measure).toHaveBeenCalledTimes(1);

      // Fresh audio invalidates the cached measurement.
      tracker.update(audio(320, 8000), SAMPLE_RATE);
      expect(tracker.volume).toEqual(0.5);
      expect(measure).toHaveBeenCalledTimes(2);
    } finally {
      mock.module("../src/audio/utils.ts", () => original);
    }
  });

  test("test_reading_less_often_than_updating_measures_latest_window", () => {
    const periodic = new AudioVolumeTracker();
    const everyChunk = new AudioVolumeTracker();
    const data = audio(SAMPLE_RATE, 8000);

    for (let i = 0; i < data.length; i += CHUNK_NUM_BYTES) {
      periodic.update(data.subarray(i, i + CHUNK_NUM_BYTES), SAMPLE_RATE);
    }
    expect(periodic.volume).toEqual(feed(everyChunk, data).at(-1) as number);
  });

  test("test_sample_rate_change_discards_window", () => {
    const tracker = new AudioVolumeTracker();
    feed(tracker, audio(SAMPLE_RATE, 8000));
    expect(tracker.volume).toBeGreaterThan(0.0);

    tracker.update(audio(320, 8000), 8000);
    expect(tracker.volume).toEqual(0.0);
    expect(bufferOf(tracker).length).toEqual(320 * 2);
  });

  test("test_reset", () => {
    const tracker = new AudioVolumeTracker();
    feed(tracker, audio(SAMPLE_RATE, 8000));
    expect(tracker.volume).toBeGreaterThan(0.0);

    tracker.reset();
    expect(tracker.volume).toEqual(0.0);
    expect(feed(tracker, audio(320, 8000))[0]).toEqual(0.0);
  });

  test("test_supported_sample_rates", () => {
    for (const sampleRate of [8000, 16000, 22050, 24000, 44100, 48000]) {
      const tracker = new AudioVolumeTracker();
      feed(tracker, audio(sampleRate, 8000), sampleRate);
      expect(tracker.volume, `sample_rate=${sampleRate}`).toBeGreaterThan(0.0);
    }
  });

  test("test_window_is_never_short_of_a_gating_block", () => {
    // Rates where 400ms isn't a whole number of samples: rounding the window
    // down would leave it just short of a gating block, which is rejected.
    for (const sampleRate of [7999, 11999, 16001, 44101]) {
      const tracker = new AudioVolumeTracker();
      feed(tracker, audio(sampleRate, 8000), sampleRate);
      expect(
        bufferOf(tracker).length / 2 / sampleRate,
        `sample_rate=${sampleRate}`,
      ).toBeGreaterThanOrEqual(VOLUME_WINDOW_SECS);
      expect(tracker.volume, `sample_rate=${sampleRate}`).toBeGreaterThan(0.0);
    }
  });
});
