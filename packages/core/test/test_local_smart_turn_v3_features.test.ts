//
// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_local_smart_turn_v3_features.py

/** Numerical-equivalence tests for the vendored Whisper log-mel extractor. */

import { describe, expect, test } from "bun:test";

import { computeWhisperLogMelFeatures } from "../src/audio/turn/smart_turn/_whisper_features.ts";

// Upstream: `transformers = pytest.importorskip("transformers")`. The reference
// implementation (`transformers.WhisperFeatureExtractor`) is a Python library
// with no JS counterpart, so — exactly like upstream when transformers is not
// installed — these tests are skipped. A reference extractor can be plugged in
// here to enable them.
interface ReferenceExtractor {
  /** `_np_extract_fbank_features(x[np.newaxis, :], device="cpu")[0]`, row-major (80, 800). */
  npExtractFbankFeatures(x: Float32Array): Float32Array;
  /** Public `__call__(...).input_features.squeeze(0)`, row-major (80, 800). */
  call(audio: Float32Array, options: { doNormalize: boolean }): Float32Array;
}
const referenceExtractor: ReferenceExtractor | undefined = undefined;
const SKIP_REASON = "transformers (WhisperFeatureExtractor reference) is not available in JS";
const maybeTest = referenceExtractor ? test : test.skip;

const N_SAMPLES = 128_000; // 8 seconds at 16 kHz

// Seeded standard-normal generator (stands in for np.random.default_rng(0xC0FFEE)).
function standardNormal(n: number, seed: number): Float64Array {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.max(next(), Number.MIN_VALUE);
    const u2 = next();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

function silence(): Float32Array {
  return new Float32Array(N_SAMPLES);
}

function noise(): Float32Array {
  const g = standardNormal(N_SAMPLES, 0xc0ffee);
  return Float32Array.from(g, (v) => v * 0.1);
}

function sweep(): Float32Array {
  const out = new Float32Array(N_SAMPLES);
  for (let i = 0; i < N_SAMPLES; i++) {
    const t = Math.fround((8 * i) / N_SAMPLES);
    out[i] = 0.5 * Math.sin(2 * Math.PI * (200 + ((4000 - 200) * t) / 8) * t);
  }
  return out;
}

function partial(): Float32Array {
  const g = standardNormal(8_000, 0xc0ffee);
  const out = new Float32Array(128_000);
  for (let i = 0; i < 8_000; i++) out[120_000 + i] = (g[i] as number) * 0.1;
  return out;
}

const FIXTURES: Array<[string, () => Float32Array]> = [
  ["silence", silence],
  ["noise", noise],
  ["sweep", sweep],
  ["partial", partial],
];

function assertAllClose(
  got: Float32Array,
  expected: Float32Array,
  rtol: number,
  atol: number,
): void {
  expect(got.length).toBe(expected.length);
  let mismatches = 0;
  for (let i = 0; i < got.length; i++) {
    const a = got[i] as number;
    const b = expected[i] as number;
    if (!(Math.abs(a - b) <= atol + rtol * Math.abs(b))) mismatches++;
  }
  expect(mismatches).toBe(0);
}

describe("test_local_smart_turn_v3_features", () => {
  for (const doNormalize of [true, false]) {
    for (const [id, audioFactory] of FIXTURES) {
      const pyId = `${doNormalize ? "True" : "False"}-${id}`;

      // SKIP: transformers reference unavailable (upstream pytest.importorskip).
      maybeTest(`test_matches_transformers_numpy_path[${pyId}] (${SKIP_REASON})`, () => {
        // The vendored implementation matches transformers' numpy code path tightly.
        const ref = referenceExtractor as ReferenceExtractor;
        const audio = audioFactory();
        const got = computeWhisperLogMelFeatures(audio, { doNormalize });

        let x = new Float32Array(N_SAMPLES);
        x.set(audio.subarray(0, N_SAMPLES));
        if (doNormalize) {
          let mean = 0;
          for (const v of x) mean += v;
          mean /= x.length;
          let variance = 0;
          for (const v of x) variance += (v - mean) * (v - mean);
          variance /= x.length;
          const denom = Math.sqrt(variance + 1e-7);
          x = Float32Array.from(x, (v) => (v - mean) / denom);
        }

        const expected = ref.npExtractFbankFeatures(x);

        expect(got.length).toBe(expected.length);
        expect(got.length).toBe(80 * 800);
        expect(got).toBeInstanceOf(Float32Array);
        assertAllClose(got, expected, 1e-5, 1e-5);
      });

      // SKIP: transformers reference unavailable (upstream pytest.importorskip).
      maybeTest(`test_matches_transformers_public_call[${pyId}] (${SKIP_REASON})`, () => {
        // The vendored implementation matches the public WhisperFeatureExtractor call.
        // Looser tolerance: transformers' torch path diverges from numpy by ~1e-4.
        const ref = referenceExtractor as ReferenceExtractor;
        const audio = audioFactory();
        const got = computeWhisperLogMelFeatures(audio, { doNormalize });
        const expected = ref.call(audio, { doNormalize });

        expect(got.length).toBe(expected.length);
        expect(got.length).toBe(80 * 800);
        assertAllClose(got, expected, 1e-4, 1e-4);
      });
    }
  }
});
