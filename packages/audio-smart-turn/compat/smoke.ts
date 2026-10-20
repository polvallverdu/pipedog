// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: runs one Smart Turn v3 inference
// through core's LocalSmartTurnAnalyzerV3 (48 kHz input, so it resamples).
// On Bun, Node and Deno the model shipped in data/ is loaded by default; on
// workerd (no filesystem) its bytes are passed in, here from a Data module.

import { createLocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`audio-smart-turn smoke: ${message}`);
}

async function modelForRuntime(): Promise<Uint8Array | undefined> {
  if (globalThis.navigator?.userAgent !== "Cloudflare-Workers") return undefined;
  const mod = (await import("../data/smart-turn-v3.2-cpu.onnx")) as { default: ArrayBuffer };
  return new Uint8Array(mod.default);
}

interface Predictor {
  setSampleRate(rate: number): void;
  _predictEndpoint(audio: Float32Array): Promise<{ prediction: number; probability: number }>;
}

export default async function smoke(): Promise<void> {
  const analyzer = createLocalSmartTurnAnalyzerV3({ model: await modelForRuntime() });
  const predictor = analyzer as unknown as Predictor;
  predictor.setSampleRate(48000);
  const audio = new Float32Array(48000 * 2);
  for (let i = 0; i < audio.length; i++) {
    audio[i] = 0.3 * Math.exp(-i / 48000) * Math.sin((2 * Math.PI * 180 * i) / 48000);
  }
  const result = await predictor._predictEndpoint(audio);
  check(result.prediction === 0 || result.prediction === 1, `prediction ${result.prediction}`);
  check(result.probability >= 0 && result.probability <= 1, `probability ${result.probability}`);
}
