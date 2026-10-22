// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for the kokoro-onnx reimplementation, without the real model.
 *
 * Reference values (trim intervals, phoneme batches) come from kokoro-onnx
 * 0.6.1 run on the same inputs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { OnnxSession, OnnxTensor } from "@pipedog/onnx";
import {
  Kokoro,
  MAX_PHONEME_LENGTH,
  pauseAfter,
  SAMPLE_RATE,
  splitPhonemes,
  Tokenizer,
  type VoiceStyle,
} from "../src/kokoro_onnx.ts";
import { parseNpz } from "../src/npz.ts";
import { trim } from "../src/trim.ts";
import splitReference from "./fixtures/split_phonemes_reference.json";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe("npz", () => {
  for (const name of ["voices_stored.npz", "voices_deflated.npz"]) {
    test(name, async () => {
      const voices = await parseNpz(new Uint8Array(readFileSync(fixture(name))));
      expect([...voices.keys()].sort()).toEqual(["af_test", "am_other"]);
      const a = voices.get("af_test") as VoiceStyle;
      expect(a.shape).toEqual([3, 1, 4]);
      expect(Array.from(a.data)).toEqual(Array.from({ length: 12 }, (_, i) => Math.fround(i / 10)));
      expect(Array.from((voices.get("am_other") as VoiceStyle).data)).toEqual(Array(8).fill(-1));
    });
  }
});

describe("trim", () => {
  test("matches librosa's trim (as vendored by kokoro-onnx)", () => {
    const parts: number[] = [];
    for (let i = 0; i < 3000; i++) parts.push(0);
    for (let i = 0; i < 12000; i++) parts.push(0.5 * Math.sin((2 * Math.PI * 440 * i) / 24000));
    for (let i = 0; i < 4000; i++) parts.push(0.0001 * Math.sin((2 * Math.PI * 440 * i) / 24000));
    for (let i = 0; i < 2000; i++) parts.push(0);
    const [out, interval] = trim(Float32Array.from(parts));
    expect(interval).toEqual([2048, 16384]);
    expect(out.length).toBe(16384 - 2048);

    const y2 = new Float32Array(5800);
    y2.fill(0.3, 100, 800);
    expect(trim(y2)[1]).toEqual([0, 2048]);
  });
});

describe("chunker", () => {
  test("splitPhonemes balances batches like kokoro-onnx", () => {
    const long = `${Array(30).fill("həlˈoʊ wˈɜːld.").join(" ")} ${Array(20).fill("ðə kwˈɪk bɹˈaʊn fˈɑːks,").join(" ")} ${"a".repeat(600)}`;
    expect(splitPhonemes(long)).toEqual(splitReference);
    for (const batch of splitPhonemes(long)) {
      expect(Array.from(batch).length).toBeLessThanOrEqual(MAX_PHONEME_LENGTH);
    }
    expect(splitPhonemes("  ")).toEqual([]);
    expect(splitPhonemes("həlˈoʊ")).toEqual(["həlˈoʊ"]);
  });

  test("pauseAfter", () => {
    expect(pauseAfter("abc. ", 0.25, 0.1)).toBe(0.25);
    expect(pauseAfter("abc…", 0.25, 0.1)).toBe(0.25);
    expect(pauseAfter("abc;", 0.25, 0.1)).toBe(0.1);
    expect(pauseAfter("abc", 0.25, 0.1)).toBe(0.0);
  });
});

describe("Tokenizer", () => {
  test("phonemize keeps only vocabulary phonemes", async () => {
    const tokenizer = new Tokenizer();
    expect(await tokenizer.phonemize("  Hello world!  ")).toBe("həlˈoʊ wˈɜːld!");
    // phonemizer 3.4.0 splits "3.50." at the first dot, as kokoro-onnx does.
    expect(await tokenizer.phonemize("Mr. Smith paid $3.50 for it.")).toBe(
      "mˈɪstɚ. smˈɪθ pˈeɪd dˈɑːlɚ θɹˈiː. fˈɪfti fɔːɹ ɪt",
    );
  });

  test("tokenize", () => {
    const tokenizer = new Tokenizer();
    expect(tokenizer.tokenize("hə!x一")).toEqual([50, 83, 5, 66]);
    expect(tokenizer.known("hə!x一")).toBe("hə!x");
    expect(() => tokenizer.tokenize("a".repeat(511))).toThrow("text is too long");
  });
});

/** A fake session recording its inputs and returning `samples` of audio per call. */
function fakeSession(
  samples: (call: number) => Float32Array,
  inputNames = ["tokens", "style", "speed"],
) {
  const calls: Record<string, OnnxTensor>[] = [];
  const session: OnnxSession = {
    inputNames,
    outputNames: ["audio"],
    async run(feeds) {
      calls.push(feeds);
      return { audio: { type: "float32", data: samples(calls.length - 1), dims: [1] } };
    },
    async dispose() {},
  };
  return { session, calls };
}

function voiceStyle(rows: number): VoiceStyle {
  const data = new Float32Array(rows * 256);
  for (let r = 0; r < rows; r++) data.fill(r, r * 256, (r + 1) * 256);
  return { data, shape: [rows, 1, 256] };
}

describe("Kokoro", () => {
  test("createStream feeds the model like kokoro-onnx", async () => {
    const loud = () => Float32Array.from({ length: 24000 }, (_, i) => 0.5 * Math.sin(i / 5));
    const { session, calls } = fakeSession(loud);
    const kokoro = new Kokoro(session, new Map([["af_test", voiceStyle(510)]]));
    const chunks: [Float32Array, number][] = [];
    for await (const chunk of kokoro.createStream("Hello world!", {
      voice: "af_test",
      speed: 1.2,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.[1]).toBe(SAMPLE_RATE);

    const feeds = calls[0] as Record<string, OnnxTensor>;
    const ids = new Tokenizer().tokenize("həlˈoʊ wˈɜːld!");
    expect(feeds.tokens?.type).toBe("int64");
    expect(Array.from(feeds.tokens?.data as BigInt64Array, Number)).toEqual([0, ...ids, 0]);
    expect(feeds.tokens?.dims).toEqual([1, ids.length + 2]);
    // Row n - 1 of the voice for n tokens.
    expect(feeds.style?.dims).toEqual([1, 256]);
    expect(((feeds.style as OnnxTensor).data as Float32Array)[0]).toBe(ids.length - 1);
    expect(feeds.speed?.type).toBe("float32");
    expect(Array.from(feeds.speed?.data as Float32Array)).toEqual([Math.fround(1.2)]);
  });

  test("batches get pauses after sentence and clause marks", async () => {
    const tone = () => Float32Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin(i / 5));
    const { session, calls } = fakeSession(tone, ["input_ids", "style", "speed"]);
    const kokoro = new Kokoro(session, new Map([["af_test", voiceStyle(510)]]));
    const phonemes = `${"a".repeat(300)}. ${"b".repeat(300)}, ${"c".repeat(300)}`;
    const chunks: Float32Array[] = [];
    for await (const [audio] of kokoro.createStream(phonemes, {
      voice: "af_test",
      isPhonemes: true,
    })) {
      chunks.push(audio);
    }
    expect(calls.length).toBe(3);
    expect(Object.keys(calls[0] as object)).toContain("input_ids");
    // Trimmed tone + 0.25 s, + 0.1 s, then nothing after the last batch.
    const trimmed = trim(tone())[0].length;
    expect(chunks.map((c) => c.length)).toEqual([trimmed + 6000, trimmed + 2400, trimmed]);
    // The style row follows each batch's token count.
    expect(
      (((calls[2] as Record<string, OnnxTensor>).style as OnnxTensor).data as Float32Array)[0],
    ).toBe(300 - 1);
  });

  test("validates speed, voice and text", async () => {
    const { session } = fakeSession(() => new Float32Array(10));
    const kokoro = new Kokoro(session, new Map([["af_test", voiceStyle(510)]]));
    const drain = async (text: string, options: Parameters<Kokoro["createStream"]>[1]) => {
      for await (const _ of kokoro.createStream(text, options)) {
        // drain
      }
    };
    await expect(drain("hi", { voice: "af_test", speed: 3 })).rejects.toThrow(
      "Speed should be between 0.5 and 2.0, got 3",
    );
    await expect(drain("hi", { voice: "nope" })).rejects.toThrow(
      "Voice nope not found in available voices",
    );
    await expect(
      drain("...", { voice: "af_test", isPhonemes: true, trim: false }),
    ).resolves.toBeUndefined();
    await expect(drain("一", { voice: "af_test", isPhonemes: true })).rejects.toThrow(
      "are in the model vocabulary",
    );
    expect(kokoro.getVoices()).toEqual(["af_test"]);
  });

  test("integer speed inputs are rounded", async () => {
    const { session, calls } = fakeSession(() => new Float32Array(10));
    const kokoro = new Kokoro(session, new Map([["af_test", voiceStyle(510)]]), {
      inputTypes: { speed: "int32" },
    });
    await kokoro.create("hi", { voice: "af_test", isPhonemes: true, speed: 1.6 });
    expect(calls[0]?.speed?.type).toBe("int32");
    expect(Array.from(calls[0]?.speed?.data as Int32Array)).toEqual([2]);
  });

  test("load reports missing files", async () => {
    await expect(
      Kokoro.load("/nonexistent/kokoro.onnx", "/nonexistent/voices.bin"),
    ).rejects.toThrow("Model file not found at /nonexistent/kokoro.onnx");
  });
});
