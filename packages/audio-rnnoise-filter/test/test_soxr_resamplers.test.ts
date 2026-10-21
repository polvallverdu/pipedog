// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_soxr_resamplers.py
//
// Upstream's file tests the soxr resamplers, the base resampler and RNNoise's
// use of them. The resampler tests live with the resamplers, in
// packages/core/test/test_soxr_resamplers.test.ts; this file holds the one test
// that needs the RNNoise filter.

import { describe, expect, test } from "bun:test";
import type { SoxrQuality } from "@pipedog/core/audio/resamplers/base_audio_resampler";
import { RNNoiseFilter, type RNNoiseLike } from "../src/index.ts";

describe("test_soxr_resamplers", () => {
  test("test_rnnoise_default_resampler_quality_is_forwarded", async () => {
    const qualities: SoxrQuality[] = [];

    // Upstream patches the RNNoise and resampler classes; here the factory and
    // the `_createResampler` hook are replaced.
    class Filter extends RNNoiseFilter {
      protected override _createResampler(quality: SoxrQuality) {
        qualities.push(quality);
        return { resample: async (audio: Uint8Array) => audio };
      }
    }
    const rnnoise: RNNoiseLike = { denoiseChunk: () => [] };

    const rnnoiseFilter = new Filter({ rnnoise: () => rnnoise });
    await rnnoiseFilter.start(16000);

    expect(qualities).toEqual(["QQ", "QQ"]);
  });

  test("a configured resampler quality is forwarded too", async () => {
    const qualities: SoxrQuality[] = [];
    class Filter extends RNNoiseFilter {
      protected override _createResampler(quality: SoxrQuality) {
        qualities.push(quality);
        return { resample: async (audio: Uint8Array) => audio };
      }
    }
    await new Filter({ resamplerQuality: "HQ", rnnoise: () => ({ denoiseChunk: () => [] }) }).start(
      8000,
    );
    expect(qualities).toEqual(["HQ", "HQ"]);
  });
});
