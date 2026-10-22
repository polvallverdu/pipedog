// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end tests with the real model (onnxruntime-node).
 *
 * Downloads the English bundle into the pipedog cache on first run (about
 * 400 MB fp32 plus the 76 MB int8 flow LM) and checks the engine against
 * reference outputs of pocket-tts 2.1.0 (PyTorch), recorded in
 * `fixtures/pocket_tts_reference.json`:
 *
 * - the SentencePiece tokenizer (English and German) and the text chunker;
 * - synthesis at `temp = 0` (deterministic): same length, same chunks, same
 *   samples to within 1e-3.
 *
 * Skipped when `PIPEDOG_E2E=0` or when Hugging Face can't be reached.
 */

import { expect, test } from "bun:test";
import { TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import {
  KYUTAI_POCKET_TTS_REPO,
  KYUTAI_TOKENIZER_REVISION,
  POCKET_TTS_ONNX_REPO,
  POCKET_TTS_ONNX_REVISION,
  splitIntoBestSentences,
  TTSModel,
} from "../src/pocket_tts.ts";
import { SentencePieceProcessor } from "../src/sentencepiece.ts";
import { PocketTTSService } from "../src/tts.ts";
import reference from "./fixtures/pocket_tts_reference.json";

const TIMEOUT_MS = 30 * 60 * 1000;

async function online(): Promise<boolean> {
  if (process.env.PIPEDOG_E2E === "0") return false;
  try {
    const res = await fetch(
      `https://huggingface.co/${POCKET_TTS_ONNX_REPO}/resolve/${POCKET_TTS_ONNX_REVISION}/onnx/english_2026-04/bundle.json`,
      { method: "HEAD", signal: AbortSignal.timeout(5000) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

const skip = !(await online());

async function tokenizer(language: string): Promise<SentencePieceProcessor> {
  const res = await fetch(
    `https://huggingface.co/${KYUTAI_POCKET_TTS_REPO}/resolve/${KYUTAI_TOKENIZER_REVISION}/languages/${language}/tokenizer.model`,
  );
  if (!res.ok) throw new Error(`tokenizer download failed: HTTP ${res.status}`);
  return new SentencePieceProcessor(new Uint8Array(await res.arrayBuffer()));
}

test.skipIf(skip)("tokenizer and chunker match pocket-tts", async () => {
  for (const language of ["english", "german"] as const) {
    const sp = await tokenizer(language);
    for (const c of reference.tokenizer[language]) {
      expect([c.text, sp.encode(c.text)]).toEqual([c.text, c.ids]);
      expect([c.ids, sp.decode(c.ids)]).toEqual([c.ids, c.decoded]);
    }
    const chunks = reference.chunks[language];
    const removeSemicolons = language === "german";
    expect(splitIntoBestSentences(sp, chunks.text, 50, false, removeSemicolons)).toEqual(
      chunks.chunks,
    );
    expect(splitIntoBestSentences(sp, chunks.text, 10, false, removeSemicolons)).toEqual(
      chunks.chunksMax10,
    );
  }
});

test.skipIf(skip)(
  "synthesis at temp=0 matches pocket-tts (english, alba)",
  async () => {
    const ref = reference.synthesis;
    const t0 = performance.now();
    const model = await TTSModel.loadModel({ language: ref.language, temp: ref.temp });
    const voice = await model.getStateForAudioPrompt(ref.voice);
    const t1 = performance.now();
    const chunks: Float32Array[] = [];
    let ttfb = 0;
    for await (const chunk of model.generateAudioStream(voice, ref.text)) {
      if (!ttfb) ttfb = performance.now() - t1;
      chunks.push(chunk.slice());
    }
    const elapsed = performance.now() - t1;
    expect(model.sampleRate).toBe(24000);
    expect(chunks.map((c) => c.length)).toEqual(ref.chunkSizes);

    const audio = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      audio.set(c, offset);
      offset += c.length;
    }
    expect(audio.length).toBe(ref.numSamples);
    let maxError = 0;
    ref.samples.forEach((v, i) => {
      maxError = Math.max(maxError, Math.abs(audio[i * ref.stride]! - v));
    });
    expect(maxError).toBeLessThan(1e-3);
    const rms = Math.sqrt(audio.reduce((s, v) => s + v * v, 0) / audio.length);
    expect(Math.abs(rms - ref.rms) / ref.rms).toBeLessThan(0.01);
    console.log(
      `pocket-tts e2e: load+voice ${(t1 - t0).toFixed(0)} ms, first chunk ${ttfb.toFixed(0)} ms, ` +
        `${((audio.length / 24000) * 1000).toFixed(0)} ms of audio in ${elapsed.toFixed(0)} ms, ` +
        `max sample error ${maxError.toExponential(2)}`,
    );
  },
  TIMEOUT_MS,
);

test.skipIf(skip)(
  "PocketTTSService speaks with the quantized model",
  async () => {
    const tts = new PocketTTSService({ quantize: true, sampleRate: 24000 });
    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello world. This is a quick test." })],
      // start() loads (and on the first run downloads) the model.
      startTimeout: 600,
    });
    const audioFrames = down.filter((f) => f instanceof TTSAudioRawFrame);
    const bytes = audioFrames.reduce((n, f) => n + f.audio.length, 0);
    const seconds = bytes / 2 / 24000;
    expect(seconds).toBeGreaterThan(1);
    expect(seconds).toBeLessThan(6);
    let sumSquares = 0;
    for (const f of audioFrames) {
      const pcm = new Int16Array(f.audio.slice().buffer);
      for (const s of pcm) sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / (bytes / 2));
    expect(rms).toBeGreaterThan(300); // not silence
  },
  TIMEOUT_MS,
);
