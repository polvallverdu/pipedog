// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Unit tests of the Pocket TTS engine (`src/pocket_tts.ts`) and its
 * SentencePiece tokenizer, with fake ONNX sessions and synthetic files: no
 * downloads. `e2e_pocket_tts.test.ts` runs the real model.
 */

import { describe, expect, test } from "bun:test";
import type { OnnxSession, OnnxTensor } from "@pipedog/onnx";
import {
  findBoundaryIndices,
  type ModelState,
  type PocketTTSBundleMetadata,
  prepareTextPrompt,
  splitIntoBestSentences,
  type TextTokenizer,
  TTSModel,
} from "../src/pocket_tts.ts";
import { PieceType, SentencePieceProcessor } from "../src/sentencepiece.ts";
import reference from "./fixtures/pocket_tts_reference.json";

// ---------------------------------------------------------------------------
// Text preparation

describe("prepareTextPrompt", () => {
  test("matches pocket-tts 2.1.0 (fixture)", () => {
    for (const c of reference.prepare) {
      expect([c.text, c.pad, c.semi, ...prepareTextPrompt(c.text, c.pad, c.semi)]).toEqual([
        c.text,
        c.pad,
        c.semi,
        c.out,
        c.framesAfterEosGuess,
      ]);
    }
  });

  test("rejects empty text", () => {
    expect(() => prepareTextPrompt("   ", false, false)).toThrow("Text prompt cannot be empty");
  });
});

test("findBoundaryIndices", () => {
  expect(findBoundaryIndices([1, 9, 2, 3, 9, 9, 4], [9])).toEqual([0, 2, 6, 7]);
  expect(findBoundaryIndices([9, 1], [9])).toEqual([0, 1, 2]);
  expect(findBoundaryIndices([], [9])).toEqual([0, 0]);
});

/** One token per character, after a `▁` dummy prefix token (like sentencepiece). */
const charTokenizer: TextTokenizer = {
  encode: (text) => [1000, ...Array.from(text, (c) => c.codePointAt(0)!)],
  decode: (ids) =>
    ids
      .filter((i) => i !== 1000)
      .map((i) => String.fromCodePoint(i))
      .join("")
      .replace(/^ /, ""),
};

test("splitIntoBestSentences groups sentences up to maxTokens", () => {
  expect(splitIntoBestSentences(charTokenizer, "ab. cd. ef", 9, false, false)).toEqual([
    "Ab. cd.",
    "ef.",
  ]);
  // A long sentence falls back to commas.
  expect(splitIntoBestSentences(charTokenizer, "abcdef, ghijkl, mn", 9, false, false)).toEqual([
    "Abcdef,",
    "ghijkl,",
    "mn.",
  ]);
});

// ---------------------------------------------------------------------------
// SentencePiece

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function field(num: number, wire: number, payload: number[]): number[] {
  return [...varint(num * 8 + wire), ...payload];
}

function bytesField(num: number, data: number[]): number[] {
  return field(num, 2, [...varint(data.length), ...data]);
}

function floatBytes(x: number): number[] {
  return Array.from(new Uint8Array(Float32Array.of(x).buffer));
}

/** Serialize a tiny Unigram `ModelProto` (byte fallback, identity normalization). */
function tinyModel(pieces: [string, number, number][]): Uint8Array {
  const enc = new TextEncoder();
  const out: number[] = [];
  for (const [piece, score, type] of pieces) {
    const body = [
      ...bytesField(1, Array.from(enc.encode(piece))),
      ...field(2, 5, floatBytes(score)),
      ...field(3, 0, varint(type)),
    ];
    out.push(...bytesField(1, body));
  }
  const trainer = [
    ...field(3, 0, varint(1)),
    ...field(35, 0, varint(1)),
    ...field(40, 0, varint(0)),
  ];
  out.push(...bytesField(2, trainer));
  const normalizer = [
    ...bytesField(1, Array.from(enc.encode("identity"))),
    ...field(3, 0, varint(1)),
    ...field(4, 0, varint(0)),
  ];
  out.push(...bytesField(3, normalizer));
  return new Uint8Array(out);
}

describe("SentencePieceProcessor", () => {
  const pieces: [string, number, number][] = [
    ["<unk>", 0, PieceType.UNKNOWN],
    ["<s>", 0, PieceType.CONTROL],
    ["</s>", 0, PieceType.CONTROL],
  ];
  for (let b = 0; b < 256; b++) {
    pieces.push([`<0x${b.toString(16).toUpperCase().padStart(2, "0")}>`, 0, PieceType.BYTE]);
  }
  const base = pieces.length;
  pieces.push(["▁", -3, PieceType.NORMAL]); // base
  pieces.push(["▁a", -2, PieceType.NORMAL]); // base + 1
  pieces.push(["b", -2, PieceType.NORMAL]); // base + 2
  pieces.push(["▁ab", -1, PieceType.NORMAL]); // base + 3
  pieces.push(["a", -4, PieceType.NORMAL]); // base + 4
  const sp = new SentencePieceProcessor(tinyModel(pieces));

  test("parses the model", () => {
    expect(sp.vocabSize()).toBe(pieces.length);
    expect(sp.model.byteFallback).toBe(true);
    expect(sp.model.removeExtraWhitespaces).toBe(false);
    expect(sp.idToPiece(base + 3)).toBe("▁ab");
  });

  test("encodes with the best-scoring segmentation", () => {
    expect(sp.encode("ab")).toEqual([base + 3]);
    expect(sp.encode("ab b")).toEqual([base + 3, base, base + 2]);
    expect(sp.encode("")).toEqual([]);
  });

  test("falls back to bytes for unknown characters", () => {
    // "é" is U+00E9, UTF-8 C3 A9.
    expect(sp.encode("é")).toEqual([base, 3 + 0xc3, 3 + 0xa9]);
    expect(sp.decode(sp.encode("é ab"))).toBe("é ab");
  });

  test("decodes, dropping the dummy prefix and control pieces", () => {
    expect(sp.decode([1, base + 3, base, base + 2, 2])).toBe("ab b");
    expect(sp.decode([0])).toBe(" ⁇ ");
  });

  test("rejects unsupported models", () => {
    const bpe = tinyModel(pieces);
    // model_type is the first TrainerSpec field written by tinyModel: patch 1 → 2 (BPE).
    const patched = bpe.slice();
    const at = patched.lastIndexOf(0x18, patched.length - 20); // field 3, wire 0
    patched[at + 1] = 2;
    expect(() => new SentencePieceProcessor(patched)).toThrow("only Unigram");
  });
});

// ---------------------------------------------------------------------------
// TTSModel with fake sessions

const LDIM = 2;
const DIM = 4;
const CAPACITY = 64;
const MODULE = "transformer.layers.0.self_attn";

const metadata: PocketTTSBundleMetadata = {
  sample_rate: 24000,
  frame_rate: 12.5,
  samples_per_frame: 3,
  latent_dim: LDIM,
  conditioning_dim: DIM,
  insert_bos_before_voice: true,
  remove_semicolons: false,
  pad_with_spaces_for_short_inputs: false,
  model_recommended_frames_after_eos: null,
  flow_lm_state_manifest: [
    {
      index: 0,
      input_name: "state_0",
      output_name: "out_state_0",
      module: MODULE,
      key: "cache",
      shape: [2, 1, CAPACITY, 1, DIM],
      dtype: "float32",
      fill: "nan",
    },
    {
      index: 1,
      input_name: "state_1",
      output_name: "out_state_1",
      module: MODULE,
      key: "current_end",
      shape: [0],
      dtype: "float32",
      fill: "empty",
    },
    {
      index: 2,
      input_name: "state_2",
      output_name: "out_state_2",
      module: MODULE,
      key: "step",
      shape: [1],
      dtype: "int64",
      fill: "zeros",
    },
  ],
  mimi_state_manifest: [
    {
      index: 0,
      input_name: "state_0",
      output_name: "out_state_0",
      module: "decoder",
      key: "count",
      shape: [1],
      dtype: "int64",
      fill: "zeros",
    },
  ],
};

function session(
  outputNames: string[],
  run: (feeds: Record<string, OnnxTensor>) => Record<string, OnnxTensor>,
): OnnxSession {
  return {
    inputNames: [],
    outputNames,
    run: async (feeds) => run(feeds),
    dispose: async () => {},
  };
}

interface MainCall {
  sequence: number[];
  seqLen: number;
  textLen: number;
  step: number;
}

/**
 * Fake graphs: the flow LM reports end-of-speech from its `eosAt`-th
 * autoregressive step of a chunk, the flow net is the constant 1 (so a latent
 * is the noise plus 1), and the decoder turns latent `[a, b]` into 3 samples of `a`.
 */
function fakeModel(
  options: { eosAt?: number; temp?: number; lsdDecodeSteps?: number; random?: () => number } = {},
) {
  const eosAt = options.eosAt ?? 3;
  const mainCalls: MainCall[] = [];
  const flowCalls: { s: number; t: number }[] = [];
  let arSteps = 0;
  const f32 = (data: Float32Array, dims: number[]): OnnxTensor => ({ type: "float32", data, dims });
  const sessions = {
    textConditioner: session(["embeddings"], (feeds) => {
      const ids = feeds.token_ids!.data as BigInt64Array;
      const out = new Float32Array(ids.length * DIM);
      for (const [i, id] of ids.entries()) out.fill(Number(id), i * DIM, (i + 1) * DIM);
      return { embeddings: f32(out, [1, ids.length, DIM]) };
    }),
    flowLmMain: session(["conditioning", "eos_logit"], (feeds) => {
      const seq = feeds.sequence!;
      const text = feeds.text_embeddings!;
      const step = Number((feeds.state_2!.data as BigInt64Array)[0]);
      const seqLen = seq.dims[1]!;
      const textLen = text.dims[1]!;
      mainCalls.push({ sequence: Array.from(seq.data as Float32Array), seqLen, textLen, step });
      if (textLen > 0) arSteps = 0;
      const eos = seqLen === 1 && arSteps++ >= eosAt ? 0 : -10;
      return {
        conditioning: f32(new Float32Array(DIM).fill(step), [1, DIM]),
        eos_logit: f32(Float32Array.of(eos), [1, 1]),
        out_state_0: feeds.state_0!,
        out_state_1: feeds.state_1!,
        out_state_2: {
          type: "int64",
          data: BigInt64Array.of(BigInt(step + seqLen + textLen)),
          dims: [1],
        },
      };
    }),
    flowLmFlow: session(["flow"], (feeds) => {
      flowCalls.push({
        s: (feeds.s!.data as Float32Array)[0]!,
        t: (feeds.t!.data as Float32Array)[0]!,
      });
      return { flow: f32(new Float32Array(LDIM).fill(1), [1, LDIM]) };
    }),
    mimiDecoder: session(["audio_frame", "out_state_0"], (feeds) => {
      const latent = feeds.latent!.data as Float32Array;
      const count = (feeds.state_0!.data as BigInt64Array)[0]!;
      return {
        audio_frame: f32(new Float32Array(3).fill(latent[0]!), [1, 1, 3]),
        out_state_0: { type: "int64", data: BigInt64Array.of(count + 1n), dims: [1] },
      };
    }),
  };
  const model = new TTSModel({
    language: "english",
    metadata,
    tokenizer: charTokenizer,
    sessions,
    temp: options.temp ?? 0,
    lsdDecodeSteps: options.lsdDecodeSteps,
    random: options.random,
    loadPredefinedVoice: async () => voiceSafetensors(5),
  });
  return { model, mainCalls, flowCalls };
}

/** A `.safetensors` voice state with a `length`-position cache and offset. */
function voiceSafetensors(length: number): Uint8Array {
  const cache = new Float32Array(2 * length * DIM).map((_, i) => i);
  const offset = BigInt64Array.of(BigInt(length));
  const header = JSON.stringify({
    [`${MODULE}/cache`]: {
      dtype: "F32",
      shape: [2, 1, length, 1, DIM],
      data_offsets: [0, cache.byteLength],
    },
    [`${MODULE}/offset`]: {
      dtype: "I64",
      shape: [1],
      data_offsets: [cache.byteLength, cache.byteLength + 8],
    },
  });
  const headerBytes = new TextEncoder().encode(header);
  const out = new Uint8Array(8 + headerBytes.length + cache.byteLength + 8);
  new DataView(out.buffer).setBigUint64(0, BigInt(headerBytes.length), true);
  out.set(headerBytes, 8);
  out.set(new Uint8Array(cache.buffer), 8 + headerBytes.length);
  out.set(new Uint8Array(offset.buffer), 8 + headerBytes.length + cache.byteLength);
  return out;
}

function stepOf(state: ModelState): number {
  return Number((state.tensors.state_2!.data as BigInt64Array)[0]);
}

async function collect(it: AsyncIterable<Float32Array>): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("TTSModel", () => {
  test("imports a predefined voice state into the graph's cache", async () => {
    const { model } = fakeModel();
    const state = await model.getStateForAudioPrompt("alba");
    expect(stepOf(state)).toBe(5);
    const cache = state.tensors.state_0!;
    expect(cache.dims).toEqual([2, 1, CAPACITY, 1, DIM]);
    const data = cache.data as Float32Array;
    // K: positions 0..4 copied, then NaN; V starts after the K block.
    expect(Array.from(data.subarray(0, 4))).toEqual([0, 1, 2, 3]);
    expect(data[5 * DIM]).toBeNaN();
    expect(data[CAPACITY * DIM]).toBe(5 * DIM);
    expect(state.tensors.state_1!.dims).toEqual([0]);
  });

  test("generates until end-of-speech plus framesAfterEos", async () => {
    const { model, mainCalls, flowCalls } = fakeModel({ eosAt: 3 });
    const state = await model.getStateForAudioPrompt("alba");
    const chunks = await collect(model.generateAudioStream(state, "hi"));
    // "hi" → "Hi." (one word): 3 + 2 frames after the EOS step 3.
    expect(chunks.length).toBe(3 + 5);
    // temp=0: no noise, so each latent is the flow (1), decoded as samples of 1.
    for (const c of chunks) expect(Array.from(c)).toEqual([1, 1, 1]);
    // Text prompt first, at the voice's offset; then a BOS (NaN) step; then latents.
    expect(mainCalls[0]).toMatchObject({ seqLen: 0, textLen: 4, step: 5 });
    expect(mainCalls[1]!.sequence.every(Number.isNaN)).toBe(true);
    expect(mainCalls[1]!.step).toBe(9);
    expect(mainCalls[2]!.sequence).toEqual([1, 1]);
    expect(flowCalls.every((c) => c.s === 0 && c.t === 1)).toBe(true);
    // copyState (default) leaves the voice state untouched.
    expect(stepOf(state)).toBe(5);
  });

  test("framesAfterEos and copyState=false", async () => {
    const { model } = fakeModel({ eosAt: 2 });
    const state = await model.getStateForAudioPrompt("alba");
    const chunks = await collect(
      model.generateAudioStream(state, "hi", { framesAfterEos: 0, copyState: false }),
    );
    expect(chunks.length).toBe(2);
    // The state advanced: 4 text tokens + 3 autoregressive steps.
    expect(stepOf(state)).toBe(5 + 4 + 3);
  });

  test("runs lsdDecodeSteps flow steps and samples noise at temp", async () => {
    const { model, flowCalls } = fakeModel({
      eosAt: 0,
      temp: 0.5,
      lsdDecodeSteps: 2,
      random: () => 0.25,
    });
    const state = await model.getStateForAudioPrompt("alba");
    const chunks = await collect(model.generateAudioStream(state, "hi", { framesAfterEos: 1 }));
    expect(chunks.length).toBe(1);
    expect(flowCalls.map((c) => [c.s, c.t])).toEqual([
      [0, 0.5],
      [0.5, 1],
    ]);
    // Box-Muller with u = v = 0.25: sqrt(-2 ln 0.25) * cos(pi / 2) = 0, scaled by sqrt(0.5).
    expect(chunks[0]![0]).toBeCloseTo(1, 6);
  });

  test("splits long text into chunks, each from the voice state", async () => {
    const { model, mainCalls } = fakeModel({ eosAt: 0 });
    const state = await model.getStateForAudioPrompt("alba");
    await collect(
      model.generateAudioStream(state, "one. two. three.", { maxTokens: 6, framesAfterEos: 0 }),
    );
    const prompts = mainCalls.filter((c) => c.textLen > 0);
    expect(prompts.map((c) => [c.textLen, c.step])).toEqual([
      [5, 5],
      [5, 5],
      [7, 5],
    ]);
  });

  test("limits generation to the cache capacity", async () => {
    const { model } = fakeModel({ eosAt: 1000 });
    const state = await model.getStateForAudioPrompt("alba");
    const text = "Abcdefghij abcdefghij abcdefgh.";
    const tokens = charTokenizer.encode(text).length;
    const chunks = await collect(model.generateAudioStream(state, text));
    // The cache holds the voice (5), the text tokens, then the generated steps.
    expect(chunks.length).toBe(CAPACITY - 5 - tokens);
  });

  test("refuses to clone a voice without the Mimi encoder", async () => {
    const { model } = fakeModel();
    expect(model.hasVoiceCloning).toBe(false);
    await expect(model.getStateForAudioPrompt("./me.wav")).rejects.toThrow(
      "Voice cloning from audio is not available",
    );
    await expect(model.getStateForAudioPrompt(new Float32Array(24000))).rejects.toThrow("gated");
  });

  test("loadModel validates the language", async () => {
    await expect(TTSModel.loadModel({ language: "french" })).rejects.toThrow("french_24l");
    await expect(TTSModel.loadModel({ language: "klingon" })).rejects.toThrow(
      "Unknown Pocket TTS language 'klingon'",
    );
  });
});
