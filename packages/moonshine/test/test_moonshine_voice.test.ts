// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests for the Moonshine engine (`moonshine_voice.ts` and
 * `moonshine_voice_engine.ts`) with fake ONNX sessions: catalog, tokenizer,
 * VAD segmentation and the two decoding loops. Real inference is in
 * `e2e_moonshine.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { OnnxSession, OnnxTensor } from "@pipedog/onnx";
import {
  crc32c,
  findModelInfo,
  getModelForLanguage,
  ModelArch,
  modelArchToString,
  stringToModelArch,
  supportedLanguages,
  supportedLanguagesFriendly,
  Transcriber,
} from "../src/moonshine_voice.ts";
import {
  BinTokenizer,
  MoonshineModel,
  MoonshineStreamingModel,
  parseStreamingConfig,
  resampleAudio,
  type SileroVad,
  sanitizeText,
  VoiceActivityDetector,
} from "../src/moonshine_voice_engine.ts";

const enc = new TextEncoder();

/** A tokenizer.bin with the given entries (one-byte lengths). */
function tokenizerBytes(entries: string[]): Uint8Array {
  const out: number[] = [];
  for (const entry of entries) {
    const bytes = enc.encode(entry);
    out.push(bytes.length, ...bytes);
  }
  return Uint8Array.from(out);
}

// 0 <unk>, 1 <s>, 2 </s>, 3 ▁hello, 4 ▁world, 5 !
const VOCAB = ["<unk>", "<s>", "</s>", "▁hello", "▁world", "!"];

function fakeSession(
  inputNames: string[],
  outputNames: string[],
  run: (feeds: Record<string, OnnxTensor>) => Record<string, OnnxTensor>,
): OnnxSession & { calls: Record<string, OnnxTensor>[] } {
  const calls: Record<string, OnnxTensor>[] = [];
  return {
    inputNames,
    outputNames,
    calls,
    async run(feeds) {
      calls.push(feeds);
      return run(feeds);
    },
    async dispose() {},
  };
}

function f32(data: number[] | Float32Array, dims: number[]): OnnxTensor {
  return { type: "float32", data: Float32Array.from(data), dims };
}

function oneHot(size: number, index: number): Float32Array {
  const v = new Float32Array(size);
  v[index] = 1;
  return v;
}

describe("catalog", () => {
  test("languages and architectures", () => {
    expect(supportedLanguages()).toEqual([
      "ar",
      "es",
      "de",
      "en",
      "ja",
      "ko",
      "vi",
      "uk",
      "zh",
      "tl",
    ]);
    expect(supportedLanguagesFriendly()).toStartWith("ar (Arabic), es (Spanish), de (German)");
    expect(stringToModelArch("small-streaming")).toBe(ModelArch.SMALL_STREAMING);
    expect(modelArchToString(ModelArch.TINY)).toBe("tiny");
    expect(() => stringToModelArch("huge")).toThrow("Invalid model architecture string: huge");
    expect(() => modelArchToString(9 as ModelArch)).toThrow("Invalid model architecture: 9");
  });

  test("default model per language, English names, missing architectures", () => {
    expect(findModelInfo("en").modelArch).toBe(ModelArch.MEDIUM_STREAMING);
    expect(findModelInfo("uk").modelArch).toBe(ModelArch.BASE);
    expect(findModelInfo("Japanese", ModelArch.TINY).downloadUrl).toBe(
      "https://download.moonshine.ai/model/tiny-ja/quantized/tiny-ja",
    );
    expect(findModelInfo("en", ModelArch.SMALL_STREAMING).downloadUrl).toBe(
      "https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21",
    );
    expect(() => findModelInfo("fr")).toThrow("Language not found: fr");
    expect(() => findModelInfo("uk", ModelArch.TINY)).toThrow("Model not found for language: uk");
  });

  test("getModelForLanguage resolves a cache path without downloading", () => {
    const [path, arch] = getModelForLanguage("en", ModelArch.TINY, { cacheRoot: "/cache" });
    expect(path).toBe("/cache/download.moonshine.ai/model/tiny-en/quantized/tiny-en");
    expect(arch).toBe(ModelArch.TINY);
  });

  test("crc32c matches the Castagnoli check value", () => {
    // CRC-32C("123456789") = 0xE3069283
    expect(crc32c(enc.encode("123456789"))).toBe("4waSgw==");
  });

  test("Transcriber validates the architecture", () => {
    expect(() => new Transcriber("/nowhere", 7 as ModelArch)).toThrow(
      "Invalid model architecture: 7",
    );
  });

  test("a missing model directory is reported on load", async () => {
    const t = new Transcriber("/nonexistent/moonshine-model", ModelArch.TINY, {
      backend: { name: "fake", createSession: async () => fakeSession([], [], () => ({})) },
    });
    await expect(t.load()).rejects.toThrow(
      "Model directory does not exist at path '/nonexistent/moonshine-model'",
    );
  });
});

describe("tokenizer and text", () => {
  test("tokens to text skips specials, turns U+2581 into spaces and trims", () => {
    const tokenizer = new BinTokenizer(tokenizerBytes(VOCAB));
    expect(new TextDecoder().decode(tokenizer.tokensToText([1, 3, 4, 5, 2]))).toBe("hello world!");
    expect(() => tokenizer.tokensToText([42])).toThrow("Invalid token 42");
  });

  test("two-byte lengths and empty entries", () => {
    const long = "x".repeat(200);
    const bytes = Uint8Array.from([
      0,
      (200 % 128) + 128,
      Math.floor(200 / 128),
      ...enc.encode(long),
    ]);
    const tokenizer = new BinTokenizer(bytes);
    expect(tokenizer.tokensToBytes.length).toBe(2);
    expect(tokenizer.tokensToBytes[1]!.length).toBe(200);
    expect(() => tokenizer.tokensToText([0])).toThrow("Invalid token 0");
  });

  test("sanitizeText replaces malformed UTF-8 with '?'", () => {
    expect(sanitizeText(Uint8Array.from([0x68, 0xc3, 0xa9, 0xff, 0xe2, 0x82]))).toBe("hé???");
  });

  test("parseStreamingConfig reads integers and defaults max_seq_len", () => {
    const config = parseStreamingConfig(
      '{"encoder_dim": 320, "decoder_dim": 320, "depth": 6, "nheads": 8, "head_dim": 40, "vocab_size": 32768, "bos_id": 1, "eos_id": 2}',
    );
    expect(config).toMatchObject({ depth: 6, vocabSize: 32768, eosId: 2, maxSeqLen: 448 });
    expect(parseStreamingConfig('{"depth": 0}')).toBeNull();
  });
});

describe("resampleAudio", () => {
  test("box-filter down, linear up", () => {
    expect(Array.from(resampleAudio(Float32Array.of(1, 3, 5, 7), 32000, 16000))).toEqual([3, 6]);
    expect(Array.from(resampleAudio(Float32Array.of(0, 1), 8000, 16000))).toEqual([0, 0.5, 1, 1]);
    const same = Float32Array.of(1, 2);
    expect(resampleAudio(same, 16000, 16000)).toBe(same);
  });
});

describe("VoiceActivityDetector", () => {
  function scriptedVad(probabilities: number[]): () => Promise<SileroVad> {
    let i = 0;
    const vad = { predict: async () => probabilities[i++] ?? 0 } as unknown as SileroVad;
    return async () => vad;
  }

  test("segments speech with look-behind and closes the last one on stop", async () => {
    // window 2: smoothed = mean of the last two probabilities.
    const probs = [0, 0, 1, 1, 1, 0, 0, 0, 1, 1];
    const detector = new VoiceActivityDetector(scriptedVad(probs), 0.5, 2, 512, 1024, 15 * 16000);
    detector.start();
    const audio = new Float32Array(probs.length * 512 + 100);
    for (let i = 0; i < audio.length; i++) audio[i] = i;
    await detector.processAudio(audio, 16000);
    detector.stop();
    const segments = detector.segments;
    expect(segments.length).toBe(2);
    // Voice starts when the mean exceeds 0.5: after chunk 3 (index 3), with
    // 1024 samples of look-behind (chunks 2 and 3).
    expect(segments[0]!.audioData[0]).toBe(2 * 512);
    expect(segments[0]!.isComplete).toBe(true);
    // Ends at chunk 5 (mean of 0 and 1), which is included.
    expect(segments[0]!.audioData.length).toBe(4 * 512);
    expect(segments[0]!.startTime).toBeCloseTo((2 * 512) / 16000, 5);
    expect(segments[0]!.endTime).toBeCloseTo((6 * 512) / 16000, 5);
    // Second segment opens at chunk 9 and is closed by stop(); the
    // 100-sample remainder is never processed.
    expect(segments[1]!.audioData.length).toBe(1024);
    expect(segments[1]!.isComplete).toBe(true);
  });

  test("a zero threshold treats everything as speech", async () => {
    const detector = new VoiceActivityDetector(scriptedVad([]), 0, 2, 512, 1024, 15 * 16000);
    detector.start();
    await detector.processAudio(new Float32Array(4096), 16000);
    detector.stop();
    expect(detector.segments.length).toBe(1);
    expect(detector.segments[0]!.audioData.length).toBe(4096);
  });
});

describe("decoding", () => {
  test("non-streaming: greedy decoding with the merged KV-cache decoder", async () => {
    const layers = 6;
    const encoder = fakeSession(
      ["input_values", "attention_mask"],
      ["last_hidden_state"],
      (feeds) => {
        expect(feeds.attention_mask!.type).toBe("int64");
        return { last_hidden_state: f32([0.5, 0.5], [1, 1, 2]) };
      },
    );
    const pastNames: string[] = [];
    const presentNames: string[] = [];
    for (let i = 0; i < layers; i++) {
      for (const a of ["decoder", "encoder"]) {
        for (const b of ["key", "value"]) {
          pastNames.push(`past_key_values.${i}.${a}.${b}`);
          presentNames.push(`present.${i}.${a}.${b}`);
        }
      }
    }
    const script = [3, 4, 5, 2];
    let step = 0;
    const decoder = fakeSession(
      [
        "encoder_attention_mask",
        "input_ids",
        "encoder_hidden_states",
        ...pastNames,
        "use_cache_branch",
      ],
      ["logits", ...presentNames],
      (feeds) => {
        expect((feeds.use_cache_branch!.data as Uint8Array)[0]).toBe(step > 0 ? 1 : 0);
        const out: Record<string, OnnxTensor> = {
          logits: f32(oneHot(VOCAB.length, script[step++]!), [1, 1, VOCAB.length]),
        };
        for (const name of presentNames) out[name] = f32([step], [1, 8, 1, 36]);
        return out;
      },
    );
    const model = new MoonshineModel(
      encoder,
      decoder,
      new BinTokenizer(tokenizerBytes(VOCAB)),
      0,
      6.5,
    );
    // 1 s of audio: up to ceil(6.5) = 7 tokens; stops at EOS after 4.
    const text = await model.transcribe(new Float32Array(16000));
    expect(new TextDecoder().decode(text)).toBe("hello world!");
    expect(decoder.calls.length).toBe(4);
    // Step 2 reuses the encoder K/V from step 1 and the decoder K/V from the previous step.
    const third = decoder.calls[2]!;
    expect((third["past_key_values.0.encoder.key"]!.data as Float32Array)[0]).toBe(1);
    expect((third["past_key_values.0.decoder.key"]!.data as Float32Array)[0]).toBe(2);
  });

  test("non-streaming: the token budget is ceil(seconds * 6.5)", async () => {
    const encoder = fakeSession(["input_values"], ["last_hidden_state"], () => ({
      last_hidden_state: f32([0], [1, 1, 1]),
    }));
    const names: string[] = [];
    for (let i = 0; i < 6; i++)
      for (const s of ["decoder.key", "decoder.value", "encoder.key", "encoder.value"])
        names.push(`${i}.${s}`);
    const decoder = fakeSession(
      [
        "input_ids",
        "encoder_hidden_states",
        ...names.map((n) => `past_key_values.${n}`),
        "use_cache_branch",
      ],
      ["logits", ...names.map((n) => `present.${n}`)],
      () => {
        const out: Record<string, OnnxTensor> = {
          logits: f32(oneHot(VOCAB.length, 3), [1, 1, VOCAB.length]),
        };
        for (const n of names) out[`present.${n}`] = f32([0], [1, 8, 1, 36]);
        return out;
      },
    );
    const model = new MoonshineModel(
      encoder,
      decoder,
      new BinTokenizer(tokenizerBytes(VOCAB)),
      0,
      6.5,
    );
    await model.transcribe(new Float32Array(8000)); // 0.5 s -> ceil(3.25) = 4
    expect(decoder.calls.length).toBe(4);
  });

  test("streaming: frontend on whole 80 ms chunks, then cross K/V and greedy decoding", async () => {
    const config = parseStreamingConfig(
      '{"encoder_dim": 2, "decoder_dim": 2, "depth": 1, "nheads": 1, "head_dim": 1, "vocab_size": 6, "bos_id": 1, "eos_id": 2, "total_lookahead": 16, "d_model_frontend": 2, "c1": 2, "c2": 2}',
    )!;
    const frontend = fakeSession(
      [
        "audio_chunk",
        "sample_buffer",
        "sample_len",
        "conv1_buffer",
        "conv2_buffer",
        "frame_count",
        "w",
      ],
      [],
      (feeds) => {
        expect(feeds.audio_chunk!.dims).toEqual([1, 1280]);
        expect(feeds.w).toBeDefined();
        return {
          features: f32(new Float32Array(4 * 2), [1, 4, 2]),
          sample_buffer_out: f32(new Float32Array(79), [1, 79]),
          sample_len_out: { type: "int64", data: BigInt64Array.of(0n), dims: [1] },
          conv1_buffer_out: f32(new Float32Array(8), [1, 2, 4]),
          conv2_buffer_out: f32(new Float32Array(8), [1, 2, 4]),
          frame_count_out: { type: "int64", data: BigInt64Array.of(1n), dims: [1] },
        };
      },
    );
    const encoder = fakeSession(["features"], ["encoded"], (feeds) => ({
      encoded: f32(feeds.features!.data as Float32Array, feeds.features!.dims as number[]),
    }));
    const adapter = fakeSession(["encoded", "pos_offset"], ["memory"], (feeds) => ({
      memory: f32(feeds.encoded!.data as Float32Array, feeds.encoded!.dims as number[]),
    }));
    const crossKv = fakeSession(["memory"], ["k_cross", "v_cross"], (feeds) => {
      const len = feeds.memory!.dims[1] as number;
      return {
        k_cross: f32(new Float32Array(len), [1, 1, 1, len, 1]),
        v_cross: f32(new Float32Array(len), [1, 1, 1, len, 1]),
      };
    });
    const script = [3, 4, 2];
    let step = 0;
    const decoderKv = fakeSession(
      ["token", "k_self", "v_self", "out_k_cross", "out_v_cross"],
      ["logits", "out_k_self", "out_v_self"],
      (feeds) => {
        expect(feeds.k_self!.dims[3]).toBe(step); // the cache grows by one per token
        const len = step + 1;
        return {
          logits: f32(oneHot(6, script[step++]!), [1, 1, 6]),
          out_k_self: f32(new Float32Array(len), [1, 1, 1, len, 1]),
          out_v_self: f32(new Float32Array(len), [1, 1, 1, len, 1]),
        };
      },
    );
    const model = new MoonshineStreamingModel({
      config,
      frontend,
      encoder,
      adapter,
      crossKv,
      decoderKv,
      tokenizer: new BinTokenizer(tokenizerBytes(VOCAB)),
      frontendSplitWeights: [{ name: "w", tensor: f32([1], [1]) }],
      // 3000 samples are 0.1875 s: a budget of ceil(0.1875 * 20) = 4 tokens.
      maxTokensPerSecond: 20,
    });
    const state = model.createState();
    // 3000 samples: two whole chunks; the 440-sample remainder is dropped.
    const text = await model.transcribeSegment(state, new Float32Array(3000));
    expect(new TextDecoder().decode(text)).toBe("hello world");
    expect(frontend.calls.length).toBe(2);
    expect(state.memoryLen).toBe(8);
    expect(crossKv.calls.length).toBe(1);
    expect(decoderKv.calls.length).toBe(3);
  });
});
