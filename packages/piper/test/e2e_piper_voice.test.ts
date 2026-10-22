// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end: real Piper inference with onnxruntime.
 *
 * Downloads `en_US-amy-low` (~63 MB) from Hugging Face rhasspy/piper-voices
 * into `modelCacheDir("piper")` once. Skipped with `PIPEDOG_E2E=0` or when
 * Hugging Face can't be reached.
 */

import { expect, test } from "bun:test";
import {
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { type AudioChunk, downloadVoice, PiperVoice } from "../src/piper_voice.ts";
import { PiperTTSService, piperCacheDir } from "../src/tts.ts";

const VOICE = "en_US-amy-low";

async function online(): Promise<boolean> {
  try {
    const res = await fetch(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json",
      {
        method: "HEAD",
        signal: AbortSignal.timeout(3000),
      },
    );
    return res.status < 500;
  } catch {
    return false;
  }
}

const skip = process.env.PIPEDOG_E2E === "0" || !(await online());

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const s of samples) sum += (s / 32768) ** 2;
  return Math.sqrt(sum / samples.length);
}

test.skipIf(skip)(
  "PiperVoice synthesizes speech",
  async () => {
    const dir = await piperCacheDir();
    await downloadVoice(VOICE, dir);
    const voice = await PiperVoice.load(`${dir}/${VOICE}.onnx`);
    expect(voice.config.sampleRate).toBe(16000);

    const start = performance.now();
    const chunks: AudioChunk[] = [];
    for await (const chunk of voice.synthesize("Hello world. This is a test of Piper."))
      chunks.push(chunk);
    const samples = chunks.reduce((n, c) => n + c.audioInt16Array.length, 0);
    console.log(
      `piper e2e: ${(samples / 16000).toFixed(2)} s of audio in ${(performance.now() - start).toFixed(0)} ms`,
    );
    // One chunk per sentence.
    expect(chunks.length).toBe(2);
    expect(samples / 16000).toBeGreaterThan(1.0);
    expect(samples / 16000).toBeLessThan(6.0);
    for (const chunk of chunks) expect(rms(chunk.audioInt16Array)).toBeGreaterThan(0.02);
  },
  600_000,
);

test.skipIf(skip)(
  "PiperTTSService produces audio frames",
  async () => {
    const tts = new PiperTTSService({
      sampleRate: 24000,
      settings: new PiperTTSService.Settings({ voice: VOICE }),
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
      expect(f.sampleRate).toBe(24000);
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
    expect(pcm.length / 24000).toBeGreaterThan(0.5);
    expect(rms(pcm)).toBeGreaterThan(0.02);
  },
  600_000,
);
