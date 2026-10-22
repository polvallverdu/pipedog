// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: runs FunASRSTTService end to end with
// the real engine (front end, metadata parsing, CTC decoding, post-processing)
// on a fake ONNX backend and an in-memory stand-in for the model, so nothing
// is downloaded.

import {
  AutoModel,
  FunASRSTTService,
  FunASRSTTSettings,
  languageToFunasrLanguage,
  richTranscriptionPostprocess,
} from "@pipedog/funasr";
import type { OnnxBackend, OnnxSession } from "@pipedog/onnx";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`funasr smoke: ${message}`);
}

/** An ONNX ModelProto holding only metadata_props (what AutoModel reads). */
function fakeModel(): Uint8Array {
  const enc = new TextEncoder();
  const out: number[] = [];
  const varint = (target: number[], n: number) => {
    while (n > 127) {
      target.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    target.push(n);
  };
  const meta: Record<string, string> = {
    lfr_window_size: "7",
    lfr_window_shift: "6",
    neg_mean: Array(560).fill("0").join(","),
    inv_stddev: Array(560).fill("1").join(","),
  };
  for (const [k, v] of Object.entries(meta)) {
    const entry: number[] = [];
    for (const [field, bytes] of [
      [1, enc.encode(k)],
      [2, enc.encode(v)],
    ] as const) {
      entry.push((field << 3) | 2);
      varint(entry, bytes.length);
      entry.push(...bytes);
    }
    out.push((14 << 3) | 2);
    varint(out, entry.length);
    out.push(...entry);
  }
  return Uint8Array.from(out);
}

const TOKENS = [
  "<unk>",
  "<s>",
  "</s>",
  "▁hello",
  "▁world",
  "<|en|>",
  "<|HAPPY|>",
  "<|Speech|>",
  "<|withitn|>",
];

function fakeBackend(): OnnxBackend {
  const session: OnnxSession = {
    inputNames: ["x", "x_length", "language", "text_norm"],
    outputNames: ["logits"],
    async run(feeds) {
      const frames = (feeds.x!.dims[1] as number) + 4;
      const vocab = TOKENS.length;
      const path = [5, 6, 7, 8, 0, 3, 0, 4];
      const logits = new Float32Array(frames * vocab);
      for (let t = 0; t < frames; t++) logits[t * vocab + (path[t] ?? 0)] = 1;
      return { logits: { type: "float32", data: logits, dims: [1, frames, vocab] } };
    },
    async dispose() {},
  };
  return { name: "fake", createSession: async () => session };
}

export default async function smoke(): Promise<void> {
  check(languageToFunasrLanguage("zh-CN") === "zh", "language mapping");
  check(
    richTranscriptionPostprocess("<|en|><|SAD|><|Speech|><|woitn|>hi") === "hi😔",
    "postprocess",
  );

  const modelOptions = { modelFile: fakeModel(), tokens: TOKENS, backend: fakeBackend() };
  const model = new AutoModel({ model: "iic/SenseVoiceSmall", ...modelOptions });
  const [raw] = await model.generate({
    input: new Float32Array(8000),
    language: "en",
    useItn: true,
  });
  check(raw?.text === "<|en|><|HAPPY|><|Speech|><|withitn|> hello world", `raw text ${raw?.text}`);

  const service = new FunASRSTTService({
    settings: new FunASRSTTSettings({ language: "en" }),
    modelOptions,
  });
  const pcm = new Uint8Array(16000 * 2);
  const texts: string[] = [];
  for await (const frame of service.runStt(pcm)) {
    texts.push((frame as unknown as { text: string }).text);
  }
  check(texts.length === 1 && texts[0] === "hello world😊", `transcript ${JSON.stringify(texts)}`);
}
