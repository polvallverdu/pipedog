// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for the Piper engine (`piper_voice.ts`), without a real voice model.
 *
 * Reference phonemes come from piper-tts 1.8.0 (see
 * `packages/espeak-ng/test/fixtures/python_reference.py`).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEspeakNG } from "@pipedog/espeak-ng";
import type { OnnxSession, OnnxTensor } from "@pipedog/onnx";
import reference from "../../espeak-ng/test/fixtures/python_reference.json";
import {
  AudioChunk,
  BOS,
  DEFAULT_PHONEME_ID_MAP,
  downloadVoice,
  EOS,
  EspeakPhonemizer,
  PAD,
  PiperConfig,
  PiperVoice,
  phonemesToIds,
  SynthesisConfig,
} from "../src/piper_voice.ts";

const CONFIG = {
  audio: { sample_rate: 16000, quality: "low" },
  espeak: { voice: "en-us" },
  inference: { noise_scale: 0.5, length_scale: 1.1, noise_w: 0.7 },
  phoneme_id_map: DEFAULT_PHONEME_ID_MAP,
  num_symbols: 256,
  num_speakers: 1,
  speaker_id_map: {},
  piper_version: "1.0.0",
};

describe("PiperConfig", () => {
  test("fromDict", () => {
    const config = PiperConfig.fromDict(CONFIG);
    expect(config.sampleRate).toBe(16000);
    expect(config.espeakVoice).toBe("en-us");
    expect([config.noiseScale, config.lengthScale, config.noiseWScale]).toEqual([0.5, 1.1, 0.7]);
    expect(config.phonemeType).toBe("espeak");
    expect(config.hopLength).toBe(256);
    expect(config.defaultSpeakerId).toBe(0);
    const defaults = PiperConfig.fromDict({ ...CONFIG, inference: undefined });
    expect([defaults.noiseScale, defaults.lengthScale, defaults.noiseWScale]).toEqual([
      0.667, 1.0, 0.8,
    ]);
    expect(() => PiperConfig.fromDict({ ...CONFIG, phoneme_type: "klingon" })).toThrow();
  });
});

describe("phonemesToIds", () => {
  test("BOS, phonemes interleaved with PAD, EOS", () => {
    const map = { [BOS]: [1], [PAD]: [0], [EOS]: [2], a: [14], b: [15, 16] };
    expect(phonemesToIds(["a", "b", "?", "a"], map)).toEqual([1, 0, 14, 0, 15, 16, 0, 14, 0, 2]);
    expect(phonemesToIds(["a"])).toEqual([1, 0, 14, 0, 2]);
  });
});

describe("EspeakPhonemizer", () => {
  // Piper bundles newer espeak-ng data for these voices; see the espeak-ng tests.
  const dataDifferences = new Set(["en-gb-x-rp", "pt-br", "it"]);
  for (const c of reference.piper as { voice: string; text: string; sentences: string[][] }[]) {
    if (dataDifferences.has(c.voice)) continue;
    test(`matches piper: ${c.voice} ${JSON.stringify(c.text)}`, async () => {
      const phonemizer = new EspeakPhonemizer(await getEspeakNG());
      expect(phonemizer.phonemize(c.voice, c.text)).toEqual(c.sentences);
    });
  }

  test("vowel clusters", async () => {
    const phonemizer = new EspeakPhonemizer(await getEspeakNG());
    const [sentence] = phonemizer.phonemize("en-us", "I go now.", [
      ["a", "ɪ"],
      ["o", "ʊ"],
    ]);
    expect(sentence).toContain("aɪ");
    expect(sentence).toContain("oʊ");
    expect(sentence).not.toContain("ɪ");
  });
});

/** A fake session recording its feeds and returning `audio`. */
function fakeSession(audio: number[]) {
  const calls: Record<string, OnnxTensor>[] = [];
  const session: OnnxSession = {
    inputNames: ["input", "input_lengths", "scales"],
    outputNames: ["output"],
    async run(feeds) {
      calls.push(feeds);
      return {
        output: { type: "float32", data: Float32Array.from(audio), dims: [1, 1, audio.length] },
      };
    },
    async dispose() {},
  };
  return { session, calls };
}

describe("PiperVoice", () => {
  test("synthesize: one chunk per sentence, inputs like piper", async () => {
    const { session, calls } = fakeSession([0.1, -0.25, 0.2]);
    const voice = new PiperVoice({ session, config: PiperConfig.fromDict(CONFIG) });
    const chunks: AudioChunk[] = [];
    for await (const chunk of voice.synthesize("Hello world. How are you?")) chunks.push(chunk);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.sampleRate).toBe(16000);
    expect(chunks[0]?.phonemes.join("")).toBe("həlˈoʊ wˈɜːld.");

    const feeds = calls[0] as Record<string, OnnxTensor>;
    const ids = voice.phonemesToIds(chunks[0]?.phonemes as string[]);
    expect(Array.from(feeds.input?.data as BigInt64Array, Number)).toEqual(ids);
    expect(feeds.input?.dims).toEqual([1, ids.length]);
    expect(Array.from(feeds.input_lengths?.data as BigInt64Array, Number)).toEqual([ids.length]);
    expect(Array.from(feeds.scales?.data as Float32Array)).toEqual(
      [0.5, 1.1, 0.7].map(Math.fround),
    );
    expect(feeds.sid).toBeUndefined();

    // Peak-normalized.
    expect(Array.from(chunks[0]?.audioFloatArray as Float32Array)).toEqual(
      [0.4, -1, 0.8].map(Math.fround),
    );
    expect(Array.from(chunks[0]?.audioInt16Array as Int16Array)).toEqual([13106, -32767, 26213]);
  });

  test("synthesis config: speaker, scales, volume, no normalization", async () => {
    const { session, calls } = fakeSession([0.5, -0.8]);
    const voice = new PiperVoice({
      session,
      config: PiperConfig.fromDict({ ...CONFIG, num_speakers: 3, default_speaker_id: 2 }),
    });
    const chunks: AudioChunk[] = [];
    for await (const chunk of voice.synthesize(
      "Hi.",
      new SynthesisConfig({ lengthScale: 2, normalizeAudio: false, volume: 2 }),
    )) {
      chunks.push(chunk);
    }
    expect(Array.from(calls[0]?.sid?.data as BigInt64Array, Number)).toEqual([2]);
    expect(Array.from(calls[0]?.scales?.data as Float32Array)).toEqual(
      [0.5, 2, 0.7].map(Math.fround),
    );
    // Volume 2 then clipped to [-1, 1].
    expect(Array.from(chunks[0]?.audioFloatArray as Float32Array)).toEqual([1, -1]);
  });

  test("raw phoneme blocks", async () => {
    const { session } = fakeSession([0.1]);
    const voice = new PiperVoice({ session, config: PiperConfig.fromDict(CONFIG) });
    const sentences = await voice.phonemize("Say [[ hˈaɪ ]] now.");
    expect(sentences.length).toBe(1);
    expect((sentences[0] as string[]).join("")).toBe("sˈeɪ hˈaɪ nˈaʊ.");
  });

  test("text phoneme type", async () => {
    const { session } = fakeSession([0.1]);
    const voice = new PiperVoice({
      session,
      config: PiperConfig.fromDict({ ...CONFIG, phoneme_type: "text" }),
    });
    expect(await voice.phonemize("é")).toEqual([["e", "́"]]);
  });
});

describe("AudioChunk", () => {
  test("int16 conversion clips and truncates", () => {
    const chunk = new AudioChunk({
      sampleRate: 22050,
      audioFloatArray: Float32Array.of(1.5, -1.5, 0.5, -0.5, 0.00002),
      phonemes: [],
      phonemeIds: [],
    });
    expect(Array.from(chunk.audioInt16Array)).toEqual([32767, -32767, 16383, -16383, 0]);
    expect(chunk.audioInt16Bytes.length).toBe(10);
  });
});

describe("downloadVoice", () => {
  test("downloads the model and config from Hugging Face", async () => {
    const dir = mkdtempSync(join(tmpdir(), "piper-test-"));
    const urls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(String(url).includes(".onnx.json") ? "{}" : "model");
    }) as typeof fetch;
    try {
      await downloadVoice(" en_US-lessac-medium ", dir, { fetch: fakeFetch });
      expect(urls).toEqual([
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx?download=true",
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json?download=true",
      ]);
      expect(readFileSync(join(dir, "en_US-lessac-medium.onnx"), "utf8")).toBe("model");
      // Present files are not downloaded again unless forced.
      await downloadVoice("en_US-lessac-medium", dir, { fetch: fakeFetch });
      expect(urls.length).toBe(2);
      await downloadVoice("en_US-lessac-medium", dir, { fetch: fakeFetch, forceRedownload: true });
      expect(urls.length).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(downloadVoice("lessac", "/tmp")).rejects.toThrow("did not match pattern");
  });
});
