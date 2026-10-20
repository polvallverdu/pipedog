// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Smart Turn v3 on every backend, with the model from bytes, a path or a URL. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SmartTurnPrediction } from "@pipedog/core/audio/turn/smart_turn/base_smart_turn";
import { createNativeBackend, createWebBackend } from "@pipedog/onnx";
import { createLocalSmartTurnAnalyzerV3, defaultSmartTurnModelUrl } from "../src/index.ts";

interface AnalyzerInternals {
  _predictEndpoint(audioArray: Float32Array): Promise<SmartTurnPrediction>;
}

/** 2 s of a 16 kHz vowel-like tone with a decaying envelope. */
function clip(): Float32Array {
  const out = new Float32Array(32000);
  for (let i = 0; i < out.length; i++) {
    const t = i / 16000;
    out[i] =
      0.3 *
      Math.exp(-t) *
      (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 720 * t));
  }
  return out;
}

async function predict(
  options: Parameters<typeof createLocalSmartTurnAnalyzerV3>[0],
): Promise<SmartTurnPrediction> {
  const analyzer = createLocalSmartTurnAnalyzerV3(options);
  return (analyzer as unknown as AnalyzerInternals)._predictEndpoint(clip());
}

describe("Smart Turn backends", () => {
  test("onnxruntime-node and onnxruntime-web agree", async () => {
    const native = await predict({ backend: createNativeBackend() });
    const web = await predict({ backend: createWebBackend() });
    expect(native.probability).toBeGreaterThanOrEqual(0);
    expect(native.probability).toBeLessThanOrEqual(1);
    expect(Math.abs(native.probability - web.probability)).toBeLessThan(1e-3);
    expect(native.prediction).toBe(web.prediction);
  }, 60_000);

  test("loads the model from bytes, a path and a URL", async () => {
    const url = defaultSmartTurnModelUrl();
    const reference = await predict({});
    for (const model of [new Uint8Array(readFileSync(url)), url.pathname, url]) {
      const result = await predict({ model });
      expect(result.probability).toBeCloseTo(reference.probability, 6);
    }
    const viaPath = await predict({ smartTurnModelPath: url.pathname });
    expect(viaPath.probability).toBeCloseTo(reference.probability, 6);
  }, 60_000);
});
