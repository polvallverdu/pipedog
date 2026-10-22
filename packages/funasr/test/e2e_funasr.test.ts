// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * End-to-end: FunASRSTTService with the real SenseVoiceSmall int8 ONNX model
 * (239 MB, downloaded once to the pipedog cache dir) on onnxruntime, on the
 * English and Chinese sample clips that ship with the model repository.
 *
 * Skipped when PIPEDOG_E2E=0 or when Hugging Face can't be reached.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ErrorFrame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { downloadModelFile, modelCacheDir } from "@pipedog/onnx";
import { AutoModel, richTranscriptionPostprocess, senseVoiceFileUrl } from "../src/funasr.ts";
import { FunASRSTTService, FunASRSTTSettings } from "../src/stt.ts";

async function online(): Promise<boolean> {
  try {
    const res = await fetch(senseVoiceFileUrl("tokens.txt"), {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

const enabled = process.env.PIPEDOG_E2E !== "0" && (await online());

/** A 16-bit mono WAV's PCM bytes (the sample clips have a 44-byte header). */
async function samplePcm(name: string): Promise<Uint8Array> {
  const dest = join(await modelCacheDir("funasr"), "test_wavs", name);
  await downloadModelFile(senseVoiceFileUrl(`test_wavs/${name}`), dest);
  const wav = new Uint8Array(await readFile(dest));
  return wav.slice(44);
}

async function transcribe(service: FunASRSTTService, pcm: Uint8Array) {
  const frames = [];
  for await (const frame of service.runStt(pcm)) frames.push(frame);
  return frames;
}

describe("e2e_funasr", () => {
  test.skipIf(!enabled)(
    "SenseVoiceSmall transcribes English and Chinese",
    async () => {
      let t = performance.now();
      const model = new AutoModel({ model: "iic/SenseVoiceSmall" });
      await model.load();
      console.log(
        `model ready (download if needed + load): ${Math.round(performance.now() - t)} ms`,
      );

      const en = await samplePcm("en.wav");
      const zh = await samplePcm("zh.wav");

      const service = new FunASRSTTService();
      t = performance.now();
      const enFrames = await transcribe(service, en);
      console.log(`en.wav (7.2 s): ${Math.round(performance.now() - t)} ms`);
      expect(enFrames.length).toBe(1);
      const enFrame = enFrames[0] as TranscriptionFrame;
      expect(enFrame).toBeInstanceOf(TranscriptionFrame);
      console.log(`en: ${enFrame.text}`);
      expect(enFrame.language).toBe(Language.EN);
      expect(enFrame.text).toContain("The tribal chieftain called for the boy");
      expect(enFrame.text).toContain("50 pieces"); // use_itn: "fifty" -> "50"

      const zhService = new FunASRSTTService({
        settings: new FunASRSTTSettings({ language: Language.ZH, useItn: false }),
      });
      t = performance.now();
      const zhFrames = await transcribe(zhService, zh);
      console.log(`zh.wav (5.6 s): ${Math.round(performance.now() - t)} ms`);
      const zhFrame = zhFrames[0] as TranscriptionFrame;
      expect(zhFrame).toBeInstanceOf(TranscriptionFrame);
      console.log(`zh: ${zhFrame.text}`);
      expect(zhFrame.language).toBe(Language.ZH);
      expect(zhFrame.text).toContain("开饭时间早上九点至下午五点");

      // Auto language detection on the raw engine output.
      const zhFloat = Float32Array.from(
        new Int16Array(zh.buffer, zh.byteOffset, zh.length / 2),
        (v) => v / 32768,
      );
      const [raw] = await model.generate({ input: zhFloat, language: "auto", useItn: true });
      expect(raw!.text.startsWith("<|zh|>")).toBe(true);
      expect(richTranscriptionPostprocess(raw!.text)).toContain("9点");

      // Digital silence runs without errors. (SenseVoice itself hallucinates a
      // filler here, "Yeah." with language "en", exactly as sherpa-onnx does
      // with the same model, so the text isn't asserted.)
      const silence = await transcribe(service, new Uint8Array(16000 * 2));
      expect(silence.some((f) => f instanceof ErrorFrame)).toBe(false);
      expect(silence.length).toBeLessThanOrEqual(1);
    },
    600_000,
  );
});
