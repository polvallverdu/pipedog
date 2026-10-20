// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: runs Silero VAD inference at 16 kHz and
// 8 kHz. On Bun, Node and Deno the model shipped in data/ is loaded by default;
// on workerd (no filesystem) its bytes are passed in, here from a Data module.

import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { VADState } from "@pipedog/core/audio/vad/vad_analyzer";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`audio-silero smoke: ${message}`);
}

async function modelForRuntime(): Promise<Uint8Array | undefined> {
  if (globalThis.navigator?.userAgent !== "Cloudflare-Workers") return undefined;
  const mod = (await import("../data/silero_vad.onnx")) as { default: ArrayBuffer };
  return new Uint8Array(mod.default);
}

export default async function smoke(): Promise<void> {
  const model = await modelForRuntime();
  for (const rate of [16000, 8000]) {
    const analyzer = new SileroVADAnalyzer({ sampleRate: rate, model });
    analyzer.setSampleRate(rate);
    await analyzer.ready();

    const window = new Uint8Array(analyzer.numFramesRequired() * 2);
    const silence = await analyzer.voiceConfidence(window);
    check(silence >= 0 && silence < 0.1, `silence confidence ${silence} at ${rate} Hz`);

    // A loud 440 Hz tone, 20 ms frames for 1 s: the model runs on every window.
    let state: VADState = VADState.QUIET;
    const frame = new Int16Array(rate / 50);
    for (let f = 0; f < 50; f++) {
      for (let i = 0; i < frame.length; i++) {
        frame[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (f * frame.length + i)) / rate));
      }
      state = await analyzer.analyzeAudio(new Uint8Array(frame.buffer.slice(0)));
    }
    check(Object.values(VADState).includes(state), `state ${state}`);
    await analyzer.cleanup();
  }
}
