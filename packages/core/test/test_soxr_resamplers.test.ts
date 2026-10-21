// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_soxr_resamplers.py

/**
 * Upstream monkeypatches `soxr.resample` / `soxr.ResampleStream`; here the
 * equivalent is injecting a resampler engine with `setResamplerEngine()`.
 * The tests that run real audio use the default engine
 * (`@pipedog/resampler-wasm`).
 */

import { afterEach, expect, test } from "bun:test";

import { BaseAudioResampler } from "../src/audio/resamplers/base_audio_resampler.ts";
import {
  type ResamplerEngine,
  type ResamplerStreamOptions,
  setResamplerEngine,
} from "../src/audio/resamplers/engine.ts";
import { SOXRAudioResampler } from "../src/audio/resamplers/soxr_resampler.ts";
import { SOXRStreamAudioResampler } from "../src/audio/resamplers/soxr_stream_resampler.ts";

afterEach(() => {
  setResamplerEngine(null);
});

function int16Bytes(values: number[]): Uint8Array {
  return new Uint8Array(new Int16Array(values).buffer);
}

/** An engine that returns its input and records what it was called with. */
function recordingEngine(calls: Record<string, unknown>): ResamplerEngine {
  return {
    resample(audioData, inRate, outRate, quality) {
      calls.quality = quality;
      calls.in_rate = inRate;
      calls.out_rate = outRate;
      return audioData;
    },
    createStream(options: ResamplerStreamOptions) {
      Object.assign(calls, options);
      return {
        resampleChunk: (audioData) => audioData,
        clear() {},
      };
    },
  };
}

test("test_soxr_audio_resampler_uses_configured_quality", async () => {
  const calls: Record<string, unknown> = {};
  setResamplerEngine(recordingEngine(calls));

  const audio = int16Bytes([1, 2, 3, 4]);
  const result = await new SOXRAudioResampler({ quality: "HQ" }).resample(audio, 8000, 16000);

  expect(result).toEqual(audio);
  expect(calls).toEqual({ quality: "HQ", in_rate: 8000, out_rate: 16000 });
});

test("test_soxr_audio_resampler_defaults_to_vhq", async () => {
  const calls: Record<string, unknown> = {};
  setResamplerEngine(recordingEngine(calls));

  const audio = int16Bytes([1, 2, 3, 4]);
  await new SOXRAudioResampler().resample(audio, 8000, 16000);

  expect(calls.quality).toEqual("VHQ");
});

test("test_soxr_stream_audio_resampler_uses_configured_quality", async () => {
  const calls: Record<string, unknown> = {};
  setResamplerEngine(recordingEngine(calls));

  const audio = int16Bytes([1, 2, 3, 4]);
  const result = await new SOXRStreamAudioResampler({ quality: "QQ" }).resample(audio, 8000, 16000);

  expect(result).toEqual(audio);
  // DIVERGENCE (no behavior change): upstream also passes dtype="int16"; the
  // engine stream takes its sample type from the chunks it is given.
  expect(calls).toEqual({
    inRate: 8000,
    outRate: 16000,
    numChannels: 1,
    quality: "QQ",
  });
});

test("test_soxr_stream_audio_resampler_defaults_to_vhq", async () => {
  const calls: Record<string, unknown> = {};
  setResamplerEngine(recordingEngine(calls));

  const audio = int16Bytes([1, 2, 3, 4]);
  await new SOXRStreamAudioResampler().resample(audio, 8000, 16000);

  expect(calls.quality).toEqual("VHQ");
});

// Needs RNNoiseFilter, which lives in @pipedog/audio-rnnoise-filter (core cannot depend on it):
// ported in packages/audio-rnnoise-filter/test/test_soxr_resamplers.test.ts.
test.todo("test_rnnoise_default_resampler_quality_is_forwarded");

function _tone(samples: number, rate = 16000): Uint8Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    // numpy's astype(np.int16) truncates toward zero.
    out[i] = Math.trunc(Math.sin(2 * Math.PI * 300 * (i / rate)) * 10000);
  }
  return new Uint8Array(out.buffer);
}

test("test_soxr_stream_audio_resampler_flush_returns_the_held_audio", async () => {
  const resampler = new SOXRStreamAudioResampler();
  const audio = _tone(640);

  const resampled = await resampler.resample(audio, 16000, 8000);
  const flushed = await resampler.flush();

  // The filter holds audio back, so a chunk on its own comes up short; the
  // flush makes up the difference.
  expect(resampled.length).toBeLessThan(640);
  expect(Math.floor((resampled.length + flushed.length) / 2)).toEqual(320);
});

test("test_soxr_stream_audio_resampler_is_reusable_after_flush", async () => {
  const resampler = new SOXRStreamAudioResampler();
  const audio = _tone(640);

  await resampler.resample(audio, 16000, 8000);
  await resampler.flush();

  const resampled = await resampler.resample(audio, 16000, 8000);
  const flushed = await resampler.flush();

  expect(Math.floor((resampled.length + flushed.length) / 2)).toEqual(320);
});

test("test_soxr_stream_audio_resampler_reset_drops_the_held_audio", async () => {
  const resampler = new SOXRStreamAudioResampler();

  await resampler.resample(_tone(640), 16000, 8000);
  await resampler.reset();

  expect(await resampler.flush()).toEqual(new Uint8Array(0));
});

test("test_soxr_stream_audio_resampler_flush_and_reset_before_any_audio", async () => {
  const resampler = new SOXRStreamAudioResampler();

  expect(await resampler.flush()).toEqual(new Uint8Array(0));
  await resampler.reset();
});

test("test_base_audio_resampler_flush_and_reset_default_to_no_ops", async () => {
  class Passthrough extends BaseAudioResampler {
    async resample(audio: Uint8Array, _inRate: number, _outRate: number): Promise<Uint8Array> {
      return audio;
    }
  }

  const resampler = new Passthrough();

  expect(await resampler.flush()).toEqual(new Uint8Array(0));
  await resampler.reset();
});
