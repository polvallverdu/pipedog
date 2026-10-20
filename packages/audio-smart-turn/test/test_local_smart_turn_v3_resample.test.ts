// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_local_smart_turn_v3_resample.py

/**
 * The part of upstream's Smart Turn v3 resample tests that needs an ONNX
 * runtime. The resampler-only tests live in core
 * (`packages/core/test/test_local_smart_turn_v3_resample.test.ts`), which has
 * no ONNX runtime; here the analyzer comes from `createLocalSmartTurnAnalyzerV3`
 * (default `@pipedog/onnx` backend, model shipped in this package).
 */

import { describe, expect, test } from "bun:test";
import type { SmartTurnPrediction } from "@pipedog/core/audio/turn/smart_turn/base_smart_turn";
import { createLocalSmartTurnAnalyzerV3 } from "../src/index.ts";

/** Access to the protected member the upstream test calls directly. */
interface AnalyzerInternals {
  _predictEndpoint(audioArray: Float32Array): Promise<SmartTurnPrediction>;
}

/** Deterministic standard-normal samples (mulberry32 + Box-Muller). */
function standardNormal(seed: number, n: number): Float64Array {
  let state = seed >>> 0;
  const uniform = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.max(uniform(), Number.MIN_VALUE);
    const u2 = uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

/**
 * Build a deterministic 48 kHz signal with speech-like spectral content.
 *
 * Linear chirp 200 Hz -> 4 kHz + a 1 kHz tone + low-amplitude white noise.
 * (Upstream draws the noise from numpy's `default_rng(42)`; the generator
 * differs here, the distribution does not.)
 */
function _synthesize48kSpeechlike(durationSecs = 3.0): Float32Array {
  const sampleRate = 48_000;
  const n = Math.trunc(durationSecs * sampleRate);
  const noise = standardNormal(42, n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i * durationSecs) / n;
    const chirp = 0.4 * Math.sin(2 * Math.PI * (200.0 + ((4000.0 - 200.0) * t) / durationSecs) * t);
    const tone = 0.2 * Math.sin(2 * Math.PI * 1000.0 * t);
    out[i] = chirp + tone + 0.02 * (noise[i] as number);
  }
  return out;
}

describe("test_local_smart_turn_v3_resample", () => {
  test("test_predict_endpoint_on_48k_input_runs", async () => {
    // End-to-end smoke: 48 kHz input -> resample (HQ) -> features -> ONNX.
    //
    // We don't assert a specific prediction value (the model can move; the
    // test would become noise). We only assert the pipeline returns a
    // well-shaped result, which proves the HQ resampler still produces a
    // 16 kHz waveform that the Whisper feature extractor accepts.
    const analyzer = createLocalSmartTurnAnalyzerV3({ sampleRate: 48_000 });
    const audio = _synthesize48kSpeechlike();
    const result = await (analyzer as unknown as AnalyzerInternals)._predictEndpoint(audio);

    expect(new Set(Object.keys(result))).toEqual(new Set(["prediction", "probability"]));
    expect([0, 1]).toContain(result.prediction);
    expect(result.probability).toBeGreaterThanOrEqual(0.0);
    expect(result.probability).toBeLessThanOrEqual(1.0);
  }, 60_000);
});
