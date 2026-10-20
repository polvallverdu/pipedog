// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_local_smart_turn_v3_resample.py

/**
 * Tests that Smart Turn v3 still resamples correctly after dropping the soxr
 * quality preset from `VHQ` to `HQ`.
 *
 * Smart Turn v3 is a binary classifier on Whisper log-mel features at 16 kHz.
 * `VHQ` (~26-tap polyphase) vs `HQ` (~16-tap) is well below the noise floor
 * of the mel feature representation, so model predictions should be unchanged
 * on representative inputs and the resampled waveforms should be close in L2.
 *
 * These tests exist to catch regressions if anyone later changes the resampler
 * or its quality preset.
 *
 * Upstream skips the whole file when `soxr` or `onnxruntime` is missing. Here
 * the soxr resampler is a stub and there is no ONNX runtime in core, so the
 * tests that need them are `test.todo`.
 */

import { describe, expect, test } from "bun:test";

import {
  LocalSmartTurnAnalyzerV3,
  MODEL_SAMPLE_RATE,
} from "../src/audio/turn/smart_turn/local_smart_turn_v3.ts";

/** Access to the protected members the upstream test calls directly. */
interface AnalyzerInternals {
  _resampleToModelRate(audioArray: Float32Array): Float32Array;
}

/** Equivalent of `np.linspace(start, stop, num, dtype=np.float32)`. */
function linspace(start: number, stop: number, num: number): Float32Array {
  const out = new Float32Array(num);
  const step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i++) {
    out[i] = i === num - 1 ? stop : start + i * step;
  }
  return out;
}

describe("test_local_smart_turn_v3_resample", () => {
  test.todo(
    "test_resample_48k_to_16k_close_to_vhq (needs soxr: audio/resamplers/soxr_resampler soxrResample is a stub)",
  );

  test("test_resample_16k_fast_path_unchanged", () => {
    // When input is already 16 kHz the resample step must short-circuit.
    const analyzer = new LocalSmartTurnAnalyzerV3({ sampleRate: MODEL_SAMPLE_RATE });
    const audio = linspace(-0.5, 0.5, 16_000);
    const out = (analyzer as unknown as AnalyzerInternals)._resampleToModelRate(audio);
    // Fast path returns the same array object (no copy), guaranteeing zero
    // resample cost when transports already deliver 16 kHz.
    expect(out).toBe(audio);
  });

  test.todo(
    "test_predict_endpoint_on_48k_input_runs (needs onnxruntime: no ONNX runtime in core, and soxr: audio/resamplers/soxr_resampler)",
  );
});
