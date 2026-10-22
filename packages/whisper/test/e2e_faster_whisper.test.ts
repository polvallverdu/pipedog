// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end: real Whisper tiny (int8-quantized ONNX export of
 * openai/whisper-tiny, ~41 MB plus the 2.5 MB tokenizer) on a real ONNX
 * runtime, with a public speech clip (JFK's inaugural address excerpt from the
 * whisper.cpp samples, 11 s, 16 kHz mono).
 *
 * Downloads into the model cache (`$PIPEDOG_CACHE_DIR`, `~/.cache/pipedog`).
 * Skipped with `PIPEDOG_E2E=0` or when huggingface.co / github.com can't be reached.
 */

import { describe, expect, test } from "bun:test";
import {
  InputAudioRawFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { downloadModelFile, loadModelBytes, modelCacheDir } from "@pipedog/onnx";
import { type Segment, WhisperModel } from "../src/faster_whisper.ts";
import { WhisperSTTService, WhisperSTTServiceMLX } from "../src/stt.ts";

const MODEL_PROBE = "https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json";
const SAMPLE_URL = "https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav";

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

const skip =
  process.env.PIPEDOG_E2E === "0" ||
  !(await reachable(MODEL_PROBE)) ||
  !(await reachable(SAMPLE_URL));

/** The 16-bit PCM samples of a WAV file. */
function wavPcm(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = new TextDecoder().decode(wav.subarray(off, off + 4));
    const size = view.getUint32(off + 4, true);
    if (id === "data") return wav.slice(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

async function jfkPcm(): Promise<Uint8Array> {
  const dest = `${await modelCacheDir("whisper")}/samples/jfk.wav`;
  await downloadModelFile(SAMPLE_URL, dest);
  return wavPcm(await loadModelBytes(dest));
}

function toFloat(pcm: Uint8Array): Float32Array {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  return Float32Array.from(samples, (s) => s / 32768);
}

async function collect(segments: AsyncIterable<Segment>): Promise<Segment[]> {
  const out: Segment[] = [];
  for await (const s of segments) out.push(s);
  return out;
}

describe.skipIf(skip)("e2e: Whisper tiny (int8 ONNX)", () => {
  const model = new WhisperModel("tiny", { computeType: "int8" });

  test("transcribes speech and detects the language", async () => {
    const t0 = performance.now();
    await model.load();
    const loaded = performance.now();
    const audio = toFloat(await jfkPcm());
    const [segments, info] = await model.transcribe(audio, { language: null });
    const out = await collect(segments);
    const done = performance.now();
    console.log(
      `whisper tiny: load ${(loaded - t0).toFixed(0)} ms, transcribe 11 s ${(done - loaded).toFixed(0)} ms`,
    );
    const text = out
      .map((s) => s.text)
      .join("")
      .toLowerCase();
    expect(info.language).toBe("en");
    expect(text).toContain("fellow americans");
    expect(text).toContain("ask not what your country can do for you");
    for (const s of out) expect(s.noSpeechProb).toBeLessThan(0.4);
  }, 600_000);

  test("silence: high no-speech probability, no transcript", async () => {
    const silence = new Float32Array(16000 * 2);
    const [segments] = await model.transcribe(silence, { language: "en" });
    expect(await collect(segments)).toEqual([]);
    // Without the no-speech skip, whatever is decoded carries a high probability.
    const [unfiltered] = await model.transcribe(silence, {
      language: "en",
      noSpeechThreshold: null,
    });
    const out = await collect(unfiltered);
    for (const s of out) expect(s.noSpeechProb).toBeGreaterThan(0.6);
  }, 600_000);

  for (const [name, make] of [
    [
      "WhisperSTTService",
      () =>
        new WhisperSTTService({
          computeType: "int8",
          settings: new WhisperSTTService.Settings({ model: "tiny" }),
        }),
    ],
    // MLXModel.TINY with the default weights (fp32 encoder, int8 decoder).
    ["WhisperSTTServiceMLX", () => new WhisperSTTServiceMLX()],
  ] as const) {
    test(`${name}: speech gives a transcription, silence gives none`, async () => {
      const pcm = await jfkPcm();
      const service = make();
      const [down] = await runTest(service, {
        framesToSend: [
          new VADUserStartedSpeakingFrame(),
          new InputAudioRawFrame({ audio: pcm, sampleRate: 16000, numChannels: 1 }),
          new VADUserStoppedSpeakingFrame(),
          new VADUserStartedSpeakingFrame(),
          new InputAudioRawFrame({
            audio: new Uint8Array(16000 * 2 * 2),
            sampleRate: 16000,
            numChannels: 1,
          }),
          new VADUserStoppedSpeakingFrame(),
        ],
      });
      const transcripts = down.filter(
        (f): f is TranscriptionFrame => f instanceof TranscriptionFrame,
      );
      expect(transcripts.length).toBe(1);
      expect(transcripts[0]?.text.toLowerCase()).toContain("your country");
    }, 600_000);
  }
});
