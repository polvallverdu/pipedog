// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end: Moonshine `tiny` and `tiny-streaming` English models (about
 * 44 MB each, downloaded once to the pipedog cache dir) on onnxruntime, on the
 * public JFK "ask not" clip (whisper.cpp's `samples/jfk.wav`, 11 s, 16 kHz
 * mono), plus silence.
 *
 * Skipped when PIPEDOG_E2E=0 or when download.moonshine.ai or GitHub can't be
 * reached.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TranscriptionFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { downloadModelFile, modelCacheDir } from "@pipedog/onnx";
import { downloadModel, ModelArch, Transcriber } from "../src/moonshine_voice.ts";
import { Model, MoonshineSTTService, MoonshineSTTSettings } from "../src/stt.ts";

const JFK_URL = "https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav";
const PROBE_URL = "https://download.moonshine.ai/model/tiny-en/quantized/tiny-en/tokenizer.bin";

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

const enabled =
  process.env.PIPEDOG_E2E !== "0" && (await reachable(PROBE_URL)) && (await reachable(JFK_URL));

/** The 16-bit PCM of a mono WAV file (walking its chunks to find `data`). */
function wavPcm(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "data") return wav.slice(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

async function jfkPcm(): Promise<Uint8Array> {
  const dest = join(await modelCacheDir("moonshine"), "samples", "jfk.wav");
  await downloadModelFile(JFK_URL, dest);
  return wavPcm(new Uint8Array(await readFile(dest)));
}

function toFloat(pcm: Uint8Array): Float32Array {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  return Float32Array.from(samples, (s) => s / 32768);
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("e2e_moonshine", () => {
  for (const [name, arch] of [
    ["tiny", ModelArch.TINY],
    ["tiny-streaming", ModelArch.TINY_STREAMING],
  ] as const) {
    test.skipIf(!enabled)(
      `${name} (en) transcribes the JFK clip and nothing from silence`,
      async () => {
        let t = performance.now();
        const [path] = await downloadModel("en", arch);
        console.log(`${name}: model download (if needed): ${Math.round(performance.now() - t)} ms`);
        const transcriber = new Transcriber(path, arch);
        t = performance.now();
        await transcriber.load();
        console.log(`${name}: load: ${Math.round(performance.now() - t)} ms`);

        const audio = toFloat(await jfkPcm());
        t = performance.now();
        const transcript = await transcriber.transcribeWithoutStreaming(audio, 16000);
        console.log(`${name}: jfk.wav (11 s): ${Math.round(performance.now() - t)} ms`);
        const text = transcript.lines.map((line) => line.text).join(" ");
        console.log(`${name}: ${JSON.stringify(transcript.lines.map((line) => line.text))}`);

        // Four VAD segments, in order, covering the speech.
        expect(transcript.lines.length).toBe(4);
        for (const line of transcript.lines) {
          expect(line.isComplete).toBe(true);
          expect(line.audioData?.length).toBeGreaterThan(0);
        }
        expect(transcript.lines[0]!.startTime).toBeLessThan(0.5);
        expect(transcript.lines[3]!.startTime).toBeGreaterThan(7);
        const words = normalized(text);
        expect(words).toContain("and so my fellow america");
        expect(words).toContain("what your country can do for you");
        expect(words).toContain("ask what you can do for your country");

        const silence = await transcriber.transcribeWithoutStreaming(
          new Float32Array(32000),
          16000,
        );
        expect(silence.lines).toEqual([]);

        // The same audio at 48 kHz is resampled to 16 kHz by the VAD.
        const upsampled = new Float32Array(audio.length * 3);
        for (let i = 0; i < upsampled.length; i++) upsampled[i] = audio[Math.floor(i / 3)]!;
        const at48k = await transcriber.transcribeWithoutStreaming(upsampled, 48000);
        expect(normalized(at48k.lines.map((line) => line.text).join(" "))).toContain(
          "ask what you can do for your country",
        );
      },
      600_000,
    );
  }

  test.skipIf(!enabled)(
    "MoonshineSTTService transcribes a segment with the tiny model",
    async () => {
      const service = new MoonshineSTTService({
        settings: new MoonshineSTTSettings({ model: Model.TINY, language: Language.EN }),
      });
      const frames = [];
      for await (const frame of service.runStt(await jfkPcm())) frames.push(frame);
      expect(frames.length).toBe(1);
      const frame = frames[0] as TranscriptionFrame;
      expect(frame).toBeInstanceOf(TranscriptionFrame);
      expect(frame.language).toBe(Language.EN);
      expect(normalized(frame.text)).toContain("ask what you can do for your country");
    },
    600_000,
  );
});
