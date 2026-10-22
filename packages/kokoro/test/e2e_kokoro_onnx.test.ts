// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end: real Kokoro inference with onnxruntime.
 *
 * Downloads the int8 model (~92 MB) and the voices (~28 MB) from the same
 * kokoro-onnx release upstream uses into `modelCacheDir("kokoro")` once.
 * Skipped with `PIPEDOG_E2E=0` or when GitHub can't be reached.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { downloadModelFile, modelCacheDir } from "@pipedog/onnx";
import { Kokoro, SAMPLE_RATE } from "../src/kokoro_onnx.ts";
import { KOKORO_VOICES_FILE, KOKORO_VOICES_URL, KokoroTTSService } from "../src/tts.ts";

const INT8_MODEL_URL =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx";

async function online(): Promise<boolean> {
  try {
    const res = await fetch("https://github.com/thewh1teagle/kokoro-onnx/releases", {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

const skip = process.env.PIPEDOG_E2E === "0" || !(await online());

async function files(): Promise<{ model: string; voices: string }> {
  const dir = await modelCacheDir("kokoro");
  const model = await downloadModelFile(INT8_MODEL_URL, join(dir, "kokoro-v1.0.int8.onnx"));
  const voices = await downloadModelFile(KOKORO_VOICES_URL, join(dir, KOKORO_VOICES_FILE));
  return { model, voices };
}

function rms(samples: Float32Array | Int16Array, scale = 1): number {
  let sum = 0;
  for (const s of samples) sum += (s / scale) ** 2;
  return Math.sqrt(sum / samples.length);
}

test.skipIf(skip)(
  "Kokoro.createStream synthesizes speech",
  async () => {
    const { model, voices } = await files();
    const kokoro = await Kokoro.load(model, voices);
    expect(kokoro.voices.has("af_heart")).toBe(true);
    expect(kokoro.voices.size).toBe(54);

    const start = performance.now();
    const chunks: Float32Array[] = [];
    for await (const [samples, sampleRate] of kokoro.createStream(
      "Hello world. How are you today?",
      {
        voice: "af_heart",
        lang: "en-us",
      },
    )) {
      expect(sampleRate).toBe(SAMPLE_RATE);
      chunks.push(samples);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const seconds = total / SAMPLE_RATE;
    console.log(
      `kokoro e2e: ${seconds.toFixed(2)} s of audio in ${(performance.now() - start).toFixed(0)} ms`,
    );
    expect(seconds).toBeGreaterThan(1.0);
    expect(seconds).toBeLessThan(5.0);
    expect(rms(chunks[0] as Float32Array)).toBeGreaterThan(0.01);
  },
  600_000,
);

test.skipIf(skip)(
  "KokoroTTSService produces audio frames",
  async () => {
    const { model, voices } = await files();
    const tts = new KokoroTTSService({
      modelPath: model,
      voicesPath: voices,
      sampleRate: 16000,
      settings: new KokoroTTSService.Settings({ voice: "af_heart" }),
    });
    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "This is a test.", appendToContext: false })],
      startTimeout: 120,
    });
    const types = down.map((f) => f.constructor);
    expect(types).toContain(TTSStartedFrame);
    expect(types).toContain(TTSStoppedFrame);
    const audio = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
    expect(audio.length).toBeGreaterThan(0);
    let bytes = 0;
    for (const f of audio) {
      expect(f.sampleRate).toBe(16000);
      bytes += f.audio.length;
    }
    const pcm = new Int16Array(bytes / 2);
    let offset = 0;
    for (const f of audio) {
      pcm.set(
        new Int16Array(
          f.audio.buffer.slice(f.audio.byteOffset, f.audio.byteOffset + f.audio.length),
        ),
        offset,
      );
      offset += f.audio.length / 2;
    }
    expect(pcm.length / 16000).toBeGreaterThan(0.5);
    expect(rms(pcm, 32768)).toBeGreaterThan(0.01);
  },
  600_000,
);
