// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * A tiny fake Whisper for tests and the compat smoke test: a word-level
 * tokenizer with Whisper's special tokens, configs, and an ONNX backend whose
 * "encoder" and "decoder" follow a script. Speech-like input decodes to
 * `<|0.00|> Hello world. <|1.00|> <|endoftext|>`; silence puts most of the
 * probability on `<|nocaptions|>` at the start-of-transcript position.
 */

import type { OnnxBackend, OnnxSession, OnnxTensor } from "@pipedog/onnx";
import type { WhisperModelFiles } from "../src/faster_whisper.ts";

const WORDS = ["Hello", "Ġworld", ".", "Ġ", "<unk>"];
const SPECIALS = [
  "<|endoftext|>",
  "<|startoftranscript|>",
  "<|en|>",
  "<|translate|>",
  "<|transcribe|>",
  "<|startoflm|>",
  "<|startofprev|>",
  "<|nocaptions|>",
  "<|notimestamps|>",
];
const N_TIMESTAMPS = 1501;
const HEADS = 2;
const D_MODEL = 4;

/** Token ids of the fake vocabulary. */
export const FAKE_IDS = (() => {
  const ids: Record<string, number> = {};
  WORDS.forEach((w, i) => {
    ids[w] = i;
  });
  SPECIALS.forEach((s, i) => {
    ids[s] = WORDS.length + i;
  });
  return ids;
})();
const TS_BEGIN = WORDS.length + SPECIALS.length;
const VOCAB = TS_BEGIN + N_TIMESTAMPS;

function tokenizerJson(): Record<string, unknown> {
  const vocab: Record<string, number> = {};
  for (const [token, id] of Object.entries(FAKE_IDS)) vocab[token] = id;
  const added = SPECIALS.map((content) => ({
    id: FAKE_IDS[content],
    content,
    single_word: false,
    lstrip: false,
    rstrip: false,
    normalized: false,
    special: true,
  }));
  for (let i = 0; i < N_TIMESTAMPS; i++) {
    const content = `<|${(i * 0.02).toFixed(2)}|>`;
    vocab[content] = TS_BEGIN + i;
    added.push({
      id: TS_BEGIN + i,
      content,
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: false,
    });
  }
  return {
    version: "1.0",
    added_tokens: added,
    normalizer: null,
    pre_tokenizer: {
      type: "ByteLevel",
      add_prefix_space: false,
      trim_offsets: true,
      use_regex: true,
    },
    post_processor: null,
    decoder: { type: "ByteLevel", add_prefix_space: true, trim_offsets: true, use_regex: true },
    model: { type: "WordLevel", vocab, unk_token: "<unk>" },
  };
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The fake model's files, as bytes (pass them as `WhisperModelOptions.files`). */
export function fakeWhisperFiles(): Required<WhisperModelFiles> {
  return {
    "config.json": json({
      num_mel_bins: 80,
      decoder_layers: 1,
      decoder_attention_heads: HEADS,
      d_model: D_MODEL,
      vocab_size: VOCAB,
      max_target_positions: 448,
    }),
    "generation_config.json": json({}),
    "preprocessor_config.json": json({
      feature_size: 80,
      sampling_rate: 16000,
      hop_length: 160,
      chunk_length: 30,
      n_fft: 400,
    }),
    "tokenizer.json": json(tokenizerJson()),
    encoder: new Uint8Array([1]),
    decoder: new Uint8Array([2]),
  };
}

const NEXT: Record<number, number> = {
  [FAKE_IDS["<|startoftranscript|>"] as number]: TS_BEGIN,
  [TS_BEGIN]: FAKE_IDS.Hello as number,
  [FAKE_IDS.Hello as number]: FAKE_IDS.Ġworld as number,
  [FAKE_IDS.Ġworld as number]: FAKE_IDS["."] as number,
  [FAKE_IDS["."] as number]: TS_BEGIN + 50,
  [TS_BEGIN + 50]: FAKE_IDS["<|endoftext|>"] as number,
};

function encoderSession(): OnnxSession {
  return {
    inputNames: ["input_features"],
    outputNames: ["last_hidden_state"],
    async run(feeds) {
      const features = feeds.input_features?.data as Float32Array;
      let max = Number.NEGATIVE_INFINITY;
      // Exact zeros are the window's padding.
      for (const v of features) if (v !== 0 && v > max) max = v;
      // Speech: hidden state 1; silence (features at the floor, -1.5): 0.
      const hidden = new Float32Array(1500 * D_MODEL).fill(max > -1 ? 1 : 0);
      return { last_hidden_state: { type: "float32", data: hidden, dims: [1, 1500, D_MODEL] } };
    },
    async dispose() {},
  };
}

function decoderSession(): OnnxSession {
  const names = ["decoder.key", "decoder.value", "encoder.key", "encoder.value"];
  return {
    inputNames: [
      "input_ids",
      "encoder_hidden_states",
      ...names.map((n) => `past_key_values.0.${n}`),
      "use_cache_branch",
    ],
    outputNames: ["logits", ...names.map((n) => `present.0.${n}`)],
    async run(feeds) {
      const ids = feeds.input_ids as OnnxTensor;
      const [batch, seq] = ids.dims as [number, number];
      const hidden = feeds.encoder_hidden_states?.data as Float32Array;
      const speech = (hidden[0] ?? 0) > 0.5;
      const pastKey = feeds["past_key_values.0.decoder.key"] as OnnxTensor;
      const pastLen = pastKey.dims[2] as number;
      const logits = new Float32Array(batch * seq * VOCAB);
      for (let b = 0; b < batch; b++) {
        for (let s = 0; s < seq; s++) {
          const token = Number((ids.data as BigInt64Array)[b * seq + s]);
          const row = (b * seq + s) * VOCAB;
          if (speech) {
            const next = NEXT[token];
            if (next !== undefined) logits[row + next] = 10;
          } else if (token === FAKE_IDS["<|startoftranscript|>"]) {
            logits[row + (FAKE_IDS["<|nocaptions|>"] as number)] = 12;
          } else {
            logits[row + (FAKE_IDS["<|endoftext|>"] as number)] = 10;
          }
        }
      }
      const kv = (len: number): OnnxTensor => ({
        type: "float32",
        data: new Float32Array(batch * HEADS * len * (D_MODEL / HEADS)),
        dims: [batch, HEADS, len, D_MODEL / HEADS],
      });
      return {
        logits: { type: "float32", data: logits, dims: [batch, seq, VOCAB] },
        "present.0.decoder.key": kv(pastLen + seq),
        "present.0.decoder.value": kv(pastLen + seq),
        "present.0.encoder.key": kv(1500),
        "present.0.encoder.value": kv(1500),
      };
    },
    async dispose() {},
  };
}

/** A backend serving the fake encoder (model bytes `[1]`) and decoder (`[2]`). */
export function fakeWhisperBackend(): OnnxBackend {
  return {
    name: "fake-whisper",
    async createSession(model) {
      const first = (model as Uint8Array)[0];
      return first === 1 ? encoderSession() : decoderSession();
    },
  };
}
