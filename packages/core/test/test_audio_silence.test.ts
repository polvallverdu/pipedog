// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_audio_silence.py

import { describe, expect, test } from "bun:test";

import { isSilence } from "../src/audio/utils.ts";

/** Equivalent of `struct.pack(f"<{len(samples)}h", *samples)`. */
function packInt16LE(samples: number[]): Uint8Array {
  const buf = new Uint8Array(samples.length * 2);
  const view = new DataView(buf.buffer);
  samples.forEach((s, i) => {
    view.setInt16(i * 2, s, true);
  });
  return buf;
}

describe("TestIsSilencePcmRange", () => {
  test("test_full_negative_scale_is_not_silence", () => {
    for (const samples of [[-32768], [0, -32768, 0], [-20, -32768, 20]]) {
      const pcm = packInt16LE(samples);
      expect(isSilence(pcm), `samples=${JSON.stringify(samples)}`).toBe(false);
    }
  });

  test("test_threshold_and_other_signed_samples", () => {
    const cases: [number[], boolean][] = [
      [[0, 0], true],
      [[-20, 20], true],
      [[-21, 0], false],
      [[0, 21], false],
      [[-32767, 0], false],
      [[0, 32767], false],
    ];
    for (const [samples, expected] of cases) {
      const pcm = packInt16LE(samples);
      expect(isSilence(pcm), `samples=${JSON.stringify(samples)}`).toEqual(expected);
    }
  });
});
