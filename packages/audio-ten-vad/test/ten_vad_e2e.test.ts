// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End to end with TEN VAD's real WebAssembly build. Skipped unless
 * TEN_VAD_DIR points at a directory holding TEN's `ten_vad.js` and
 * `ten_vad.wasm` (from `lib/Web` in TEN's repository, under TEN's license);
 * pipedog ships neither.
 *
 *   TEN_VAD_DIR=/path/to/ten-vad/lib/Web bun test packages/audio-ten-vad
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VADParams, VADState } from "@pipedog/core/audio/vad/vad_analyzer";
import { loadTenVadModule, TenVADAnalyzer, type TenVADModuleFactory } from "../src/ten_vad.ts";

const TEN_VAD_DIR = process.env.TEN_VAD_DIR;
// Synthesized speech with every pause removed, 16 kHz mono PCM16.
const SPEECH_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "audio-silero",
  "test",
  "assets",
  "continuous_speech_16k.wav",
);

/** Read a mono PCM16 WAV file. */
function readWav(path: string): { pcm: Uint8Array; sampleRate: number } {
  const bytes = new Uint8Array(readFileSync(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") sampleRate = view.getUint32(offset + 12, true);
    else if (id === "data") return { pcm: bytes.slice(offset + 8, offset + 8 + size), sampleRate };
    offset += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

test.skipIf(!TEN_VAD_DIR)("TEN VAD: silence is quiet, speech is detected", async () => {
  const dir = TEN_VAD_DIR as string;
  const { default: factory } = (await import(pathToFileURL(join(dir, "ten_vad.js")).href)) as {
    default: TenVADModuleFactory;
  };
  const module = await loadTenVadModule({
    factory,
    wasmBinary: new Uint8Array(readFileSync(join(dir, "ten_vad.wasm"))),
  });

  for (const hopSize of [256, 160] as const) {
    const vad = new TenVADAnalyzer({
      module,
      hopSize,
      sampleRate: 16000,
      params: new VADParams({ startSecs: 0.2, stopSecs: 0.2 }),
    });
    vad.setSampleRate(16000);
    await vad.ready();

    // One second of silence.
    let maxSilence = 0;
    for (let i = 0; i < 16000 / hopSize; i++) {
      maxSilence = Math.max(maxSilence, vad.voiceConfidence(new Uint8Array(hopSize * 2)) as number);
    }
    expect(maxSilence).toBeLessThan(0.1);

    const { pcm, sampleRate } = readWav(SPEECH_PATH);
    expect(sampleRate).toBe(16000);
    let sawSpeaking = false;
    let maxSpeech = 0;
    for (let at = 0; at + hopSize * 2 <= pcm.length; at += hopSize * 2) {
      maxSpeech = Math.max(
        maxSpeech,
        vad.voiceConfidence(pcm.subarray(at, at + hopSize * 2)) as number,
      );
    }
    for (let at = 0; at + 640 <= pcm.length; at += 640) {
      if ((await vad.analyzeAudio(pcm.subarray(at, at + 640))) === VADState.SPEAKING) {
        sawSpeaking = true;
      }
    }
    expect(maxSpeech).toBeGreaterThan(0.7);
    expect(sawSpeaking).toBe(true);
    await vad.cleanup();
  }
});
