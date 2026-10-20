// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Silero on every backend: onnxruntime-node and onnxruntime-web give the same
 * confidences, at 16 kHz and 8 kHz, and the model loads from bytes, a path
 * and a URL.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VADState } from "@pipedog/core/audio/vad/vad_analyzer";
import { createNativeBackend, createWebBackend, type OnnxBackend } from "@pipedog/onnx";
import { defaultSileroModelUrl, SileroVADAnalyzer } from "../src/silero.ts";

const wav = new Uint8Array(
  readFileSync(join(import.meta.dir, "assets", "continuous_speech_16k.wav")),
);
// 16 kHz PCM16 after the 44-byte header; the first ~2 s.
const speech16k = wav.slice(44, 44 + 2 * 32000);

/** Every other sample: crude 8 kHz audio, enough to compare backends. */
function decimate(pcm: Uint8Array): Uint8Array {
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  return new Uint8Array(
    Int16Array.from({ length: s.length >> 1 }, (_, i) => s[2 * i] as number).buffer,
  );
}

async function confidences(backend: OnnxBackend, rate: number, pcm: Uint8Array): Promise<number[]> {
  const analyzer = new SileroVADAnalyzer({ sampleRate: rate, backend });
  analyzer.setSampleRate(rate);
  const window = analyzer.numFramesRequired() * 2;
  const out: number[] = [];
  for (let i = 0; i + window <= pcm.length; i += window) {
    out.push(await analyzer.voiceConfidence(pcm.slice(i, i + window)));
  }
  await analyzer.cleanup();
  return out;
}

describe("Silero backends", () => {
  for (const rate of [16000, 8000]) {
    test(`onnxruntime-node and onnxruntime-web agree at ${rate} Hz`, async () => {
      const pcm = rate === 16000 ? speech16k : decimate(speech16k);
      const native = await confidences(await createNativeBackend(), rate, pcm);
      const web = await confidences(await createWebBackend(), rate, pcm);
      expect(native.length).toBeGreaterThan(50);
      expect(Math.max(...native)).toBeGreaterThan(0.9); // it is speech
      for (let i = 0; i < native.length; i++) {
        expect(Math.abs((native[i] as number) - (web[i] as number))).toBeLessThan(1e-3);
      }
    });
  }

  test("loads the model from bytes, a path and a URL", async () => {
    const url = defaultSileroModelUrl();
    const sources = [new Uint8Array(readFileSync(url)), url.pathname, url, url.href];
    for (const model of sources) {
      const analyzer = new SileroVADAnalyzer({ sampleRate: 16000, model });
      analyzer.setSampleRate(16000);
      await analyzer.ready();
      let state: VADState = VADState.QUIET;
      for (let i = 0; i + 640 <= speech16k.length; i += 640) {
        state = await analyzer.analyzeAudio(speech16k.slice(i, i + 640));
      }
      expect(state).toBe(VADState.SPEAKING);
      await analyzer.cleanup();
    }
  });

  test("a model that cannot load rejects analyzeAudio", async () => {
    const analyzer = new SileroVADAnalyzer({
      sampleRate: 16000,
      model: "/nonexistent/silero.onnx",
    });
    analyzer.setSampleRate(16000);
    await expect(analyzer.ready()).rejects.toThrow();
    await expect(analyzer.analyzeAudio(speech16k.slice(0, 2048))).rejects.toThrow();
  });
});
