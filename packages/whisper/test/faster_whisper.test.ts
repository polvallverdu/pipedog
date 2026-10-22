// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** Tests for the ONNX faster-whisper engine that need no model download. */

import { describe, expect, test } from "bun:test";
import {
  InputAudioRawFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import {
  computeTypeToDtypes,
  FeatureExtractor,
  knownMultilingual,
  LANGUAGE_CODES,
  resolveModelRepo,
  type Segment,
  WhisperModel,
} from "../src/faster_whisper.ts";
import { MLXModel, Model, WhisperSTTService } from "../src/stt.ts";
import { FAKE_IDS, fakeWhisperBackend, fakeWhisperFiles } from "./fake_whisper.ts";

function fakeModel(): WhisperModel {
  return new WhisperModel("fake", {
    files: fakeWhisperFiles(),
    backend: fakeWhisperBackend(),
    shareSession: false,
  });
}

function tone(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(16000 * seconds));
  for (let i = 0; i < out.length; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16000);
  return out;
}

async function collect(segments: AsyncIterable<Segment>): Promise<Segment[]> {
  const out: Segment[] = [];
  for await (const s of segments) out.push(s);
  return out;
}

describe("FeatureExtractor", () => {
  test("matches a direct DFT log-mel computation", () => {
    const fe = new FeatureExtractor();
    const n = 4000;
    const audio = new Float32Array(n);
    let seed = 1;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      audio[i] = (seed / 2 ** 31 - 0.5) * 0.5;
    }
    const { data, nMels, nFrames } = fe.compute(audio);
    expect(nMels).toBe(80);
    // (n + 160 padding + 2·200 reflect - 400) / 160 + 1 frames, minus the last.
    expect(nFrames).toBe(Math.floor((n + 160) / 160));

    // Reference: direct DFT of each reflect-padded, windowed frame.
    const length = n + 160;
    const signal = new Float64Array(length);
    signal.set(audio);
    const reflect = (i: number) => (i < 0 ? -i : i >= length ? 2 * (length - 1) - i : i);
    const logSpec = new Float64Array(80 * nFrames);
    let max = Number.NEGATIVE_INFINITY;
    for (let t = 0; t < nFrames; t++) {
      const power = new Float64Array(201);
      for (let k = 0; k < 201; k++) {
        let re = 0;
        let im = 0;
        for (let j = 0; j < 400; j++) {
          const x =
            (signal[reflect(t * 160 - 200 + j)] as number) *
            (0.5 - 0.5 * Math.cos((2 * Math.PI * j) / 400));
          re += x * Math.cos((2 * Math.PI * k * j) / 400);
          im -= x * Math.sin((2 * Math.PI * k * j) / 400);
        }
        power[k] = re * re + im * im;
      }
      for (let m = 0; m < 80; m++) {
        let acc = 0;
        for (let k = 0; k < 201; k++)
          acc += (fe.melFilters[m * 201 + k] as number) * (power[k] as number);
        const v = Math.log10(Math.max(acc, 1e-10));
        logSpec[m * nFrames + t] = v;
        max = Math.max(max, v);
      }
    }
    let worst = 0;
    for (let i = 0; i < logSpec.length; i++) {
      const ref = (Math.max(logSpec[i] as number, max - 8) + 4) / 4;
      worst = Math.max(worst, Math.abs(ref - (data[i] as number)));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  test("supports 128 mel bins (large-v3)", () => {
    const fe = new FeatureExtractor({ featureSize: 128 });
    const { nMels, data, nFrames } = fe.compute(tone(1));
    expect(nMels).toBe(128);
    expect(data.length).toBe(128 * nFrames);
  });
});

describe("model names", () => {
  test("upstream's Model values resolve to ONNX exports of the same checkpoints", () => {
    expect(resolveModelRepo(Model.TINY).repo).toBe("onnx-community/whisper-tiny");
    expect(resolveModelRepo(Model.LARGE).repo).toBe("onnx-community/whisper-large-v3-ONNX");
    expect(resolveModelRepo(Model.LARGE_V3_TURBO).repo).toBe(
      "onnx-community/whisper-large-v3-turbo",
    );
    expect(resolveModelRepo(Model.DISTIL_LARGE_V2).repo).toBe("distil-whisper/distil-large-v2");
    expect(resolveModelRepo(Model.DISTIL_MEDIUM_EN).repo).toBe("distil-whisper/distil-medium.en");
    expect(resolveModelRepo("someone/whisper-custom-onnx").repo).toBe(
      "someone/whisper-custom-onnx",
    );
    expect(resolveModelRepo("/models/whisper").dir).toBe("/models/whisper");
    expect(() => resolveModelRepo("gigantic")).toThrow("Invalid model size");
    expect(MLXModel.TINY).toBe("mlx-community/whisper-tiny");
  });

  test("supported languages follow faster-whisper", () => {
    expect(knownMultilingual(Model.DISTIL_MEDIUM_EN)).toBe(false);
    expect(knownMultilingual(Model.DISTIL_LARGE_V2)).toBe(true);
    expect(knownMultilingual("someone/custom")).toBeNull();
    expect(new WhisperModel("small.en").supportedLanguages).toEqual(["en"]);
    expect(new WhisperModel("small").supportedLanguages).toEqual([...LANGUAGE_CODES]);
    expect(new WhisperModel("someone/custom").supportedLanguages).toBeNull();
  });

  test("compute types map to ONNX weight variants", () => {
    expect(computeTypeToDtypes("default")).toEqual({ encoder: "fp32", decoder: "q8" });
    expect(computeTypeToDtypes("int8_float16")).toEqual({ encoder: "q8", decoder: "q8" });
    expect(computeTypeToDtypes("float32")).toEqual({ encoder: "fp32", decoder: "fp32" });
    expect(computeTypeToDtypes("q4")).toEqual({ encoder: "q4", decoder: "q4" });
    expect(() => computeTypeToDtypes("int4_magic")).toThrow("Unsupported compute type");
    expect(new WhisperModel("tiny", { dtype: { encoder: "q4" } }).dtypes).toEqual({
      encoder: "q4",
      decoder: "q8",
    });
  });
});

describe("decoding (fake model)", () => {
  test("speech decodes to timestamped segments", async () => {
    const model = fakeModel();
    const [segments, info] = await model.transcribe(tone(2), { language: "en" });
    expect(info.language).toBe("en");
    const out = await collect(segments);
    expect(out.map((s) => s.text)).toEqual(["Hello world."]);
    expect(out[0]?.start).toBe(0);
    expect(out[0]?.end).toBe(1);
    expect(out[0]?.noSpeechProb).toBeLessThan(0.01);
    // The first token is forced to be a timestamp: <|0.00|>.
    expect(out[0]?.tokens[0]).toBe((FAKE_IDS["<|notimestamps|>"] as number) + 1);
  });

  test("greedy and beam search agree on a confident model", async () => {
    const model = fakeModel();
    const [greedy] = await model.transcribe(tone(2), { language: "en", beamSize: 1 });
    const [beam] = await model.transcribe(tone(2), { language: "en", beamSize: 5 });
    expect((await collect(greedy)).map((s) => s.text)).toEqual(
      (await collect(beam)).map((s) => s.text),
    );
  });

  test("silence has a high no-speech probability and no segments", async () => {
    const model = fakeModel();
    const [segments] = await model.transcribe(new Float32Array(32000), { language: "en" });
    expect(await collect(segments)).toEqual([]);
    const [unfiltered] = await model.transcribe(new Float32Array(32000), {
      language: "en",
      noSpeechThreshold: null,
      temperature: 0,
    });
    for (const s of await collect(unfiltered)) expect(s.noSpeechProb).toBeGreaterThan(0.9);
  });

  test("the prompt carries hotwords and the previous text", () => {
    const model = fakeModel();
    return model.load().then(async () => {
      const { Tokenizer } = await import("../src/faster_whisper.ts");
      const files = fakeWhisperFiles();
      const { Tokenizer: HF } = await import("@huggingface/tokenizers");
      const hf = new HF(
        JSON.parse(new TextDecoder().decode(files["tokenizer.json"] as Uint8Array)),
        {},
      );
      const tokenizer = new Tokenizer(hf as never, false, {});
      const prompt = model.getPrompt(tokenizer, [FAKE_IDS.Hello as number], { hotwords: "world" });
      expect(prompt[0]).toBe(tokenizer.sotPrev);
      expect(prompt.at(-1)).toBe(tokenizer.sot);
      expect(prompt.at(-2)).toBe(FAKE_IDS.Hello as number);
      const plain = model.getPrompt(tokenizer, [], { withoutTimestamps: true });
      expect(plain).toEqual([tokenizer.sot, tokenizer.noTimestamps]);
    });
  });
});

describe("WhisperSTTService (fake model)", () => {
  test("a VAD segment yields one transcription", async () => {
    const service = new WhisperSTTService({
      settings: new WhisperSTTService.Settings({ model: "tiny" }),
      modelOptions: {
        files: fakeWhisperFiles(),
        backend: fakeWhisperBackend(),
        shareSession: false,
      },
      trailingSilenceSecs: 0,
    });
    const audio = tone(1.5);
    const pcm = new Uint8Array(audio.length * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < audio.length; i++)
      view.setInt16(i * 2, Math.round((audio[i] as number) * 32767), true);
    const [down] = await runTest(service, {
      framesToSend: [
        new VADUserStartedSpeakingFrame(),
        new InputAudioRawFrame({ audio: pcm, sampleRate: 16000, numChannels: 1 }),
        new VADUserStoppedSpeakingFrame(),
      ],
    });
    const transcripts = down.filter(
      (f): f is TranscriptionFrame => f instanceof TranscriptionFrame,
    );
    expect(transcripts.map((f) => f.text.trim())).toEqual(["Hello world."]);
    expect(transcripts[0]?.language).toBe("en");
  });
});
