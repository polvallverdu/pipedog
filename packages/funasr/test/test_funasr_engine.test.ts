// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Offline tests for the SenseVoice engine (`src/funasr.ts` and its helpers):
 * post-processing against FunASR's Python output, the front end, CTC
 * decoding, ONNX metadata parsing and `AutoModel` with a fake ONNX backend.
 */

import { describe, expect, test } from "bun:test";
import type { OnnxBackend, OnnxSession, OnnxTensor } from "@pipedog/onnx";
import { applyLfr, kaldiFbank, senseVoiceFeatures } from "../src/frontend.ts";
import { AutoModel, ctcGreedySearch, decodePieces, parseTokens } from "../src/funasr.ts";
import { readOnnxMetadataFromBytes } from "../src/onnx_metadata.ts";
import { richTranscriptionPostprocess } from "../src/postprocess_utils.ts";

describe("richTranscriptionPostprocess", () => {
  // Expected values from FunASR's funasr/utils/postprocess_utils.py.
  const cases: [string, string][] = [
    [
      "<|en|><|NEUTRAL|><|Speech|><|withitn|>The tribal chieftain called for the boy.",
      "The tribal chieftain called for the boy.",
    ],
    [
      "<|zh|><|HAPPY|><|Speech|><|withitn|>开饭时间早上9点至下午5点。",
      "开饭时间早上9点至下午5点。😊",
    ],
    ["<|en|><|EMO_UNKNOWN|><|BGM|><|woitn|> hello world", "🎼hello world"],
    [
      "<|en|><|SAD|><|Laughter|><|woitn|>ha ha<|zh|><|SAD|><|Laughter|><|woitn|>哈哈",
      "😀ha ha哈哈😔",
    ],
    ["<|nospeech|><|Event_UNK|>", "❓"],
    [
      "<|ja|><|ANGRY|><|Applause|><|withitn|>すごい<|en|><|HAPPY|><|Speech|><|withitn|>The. great",
      "👏すごい😡  great😊",
    ],
    ["", ""],
    ["   ", ""],
    ["<|ko|><|NEUTRAL|><|Cough|><|woitn|>", "😷"],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      expect(richTranscriptionPostprocess(input)).toBe(expected);
    });
  }
});

describe("front end", () => {
  test("fbank frame count follows snip_edges", () => {
    expect(kaldiFbank(new Float32Array(399)).rows).toBe(0);
    expect(kaldiFbank(new Float32Array(400)).rows).toBe(1);
    expect(kaldiFbank(new Float32Array(16000)).rows).toBe(98);
    const silent = kaldiFbank(new Float32Array(400));
    // log(FLT_EPSILON) for an all-zero frame.
    expect(silent.data[0]).toBeCloseTo(Math.log(1.1920928955078125e-7), 4);
  });

  test("LFR stacks 7 frames every 6 with edge padding", () => {
    const rows = 10;
    const data = Float32Array.from({ length: rows }, (_, i) => i);
    const lfr = applyLfr({ data, rows, cols: 1 }, 7, 6);
    expect(lfr.rows).toBe(2);
    expect(lfr.cols).toBe(7);
    expect([...lfr.data.subarray(0, 7)]).toEqual([0, 0, 0, 0, 1, 2, 3]);
    expect([...lfr.data.subarray(7, 14)]).toEqual([3, 4, 5, 6, 7, 8, 9]);
    const tail = applyLfr({ data, rows: 8, cols: 1 }, 7, 6);
    expect([...tail.data.subarray(7, 14)]).toEqual([3, 4, 5, 6, 7, 7, 7]);
  });

  test("a clip shorter than one frame still yields one frame", () => {
    const feats = senseVoiceFeatures(new Float32Array(200).fill(0.1), {
      lfrM: 7,
      lfrN: 6,
      negMean: new Float32Array(560),
      invStddev: new Float32Array(560).fill(1),
    });
    expect(feats.rows).toBe(1);
    expect(feats.cols).toBe(560);
  });
});

describe("decoding", () => {
  const tokens = parseTokens(
    "<unk> 0\n<s> 1\n</s> 2\n▁hello 3\n▁world 4\n<|en|> 5\n<|NEUTRAL|> 6\n<|Speech|> 7\n<|woitn|> 8\n",
  );

  test("parseTokens", () => {
    expect(tokens.length).toBe(9);
    expect(tokens[3]).toBe("▁hello");
  });

  test("CTC greedy search collapses repeats and drops blanks", () => {
    const vocab = 4;
    const path = [1, 1, 0, 1, 2, 2, 0, 0, 3];
    const logits = new Float32Array(path.length * vocab);
    path.forEach((id, t) => {
      logits[t * vocab + id] = 5;
    });
    expect(ctcGreedySearch(logits, path.length, vocab)).toEqual([1, 1, 2, 3]);
  });

  test("decodePieces follows SentencePiece", () => {
    expect(decodePieces([3, 4], tokens)).toBe("hello world");
    expect(decodePieces([5, 6, 7, 8, 3, 4], tokens)).toBe(
      "<|en|><|NEUTRAL|><|Speech|><|woitn|> hello world",
    );
    expect(decodePieces([1, 3, 2], tokens)).toBe("hello");
  });
});

/** A minimal ONNX ModelProto: ir_version, a fake graph and metadata_props. */
function fakeOnnxModel(metadata: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const out: number[] = [];
  const varint = (n: number) => {
    while (n > 127) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
  };
  const bytesField = (field: number, bytes: number[] | Uint8Array) => {
    varint((field << 3) | 2);
    varint(bytes.length);
    out.push(...bytes);
  };
  varint(1 << 3);
  varint(8); // ir_version
  bytesField(7, new Uint8Array(300).fill(7)); // graph
  for (const [k, v] of Object.entries(metadata)) {
    const entry: number[] = [];
    const kb = enc.encode(k);
    const vb = enc.encode(v);
    const push = (field: number, b: Uint8Array) => {
      entry.push((field << 3) | 2);
      let n = b.length;
      while (n > 127) {
        entry.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 128);
      }
      entry.push(n);
      entry.push(...b);
    };
    push(1, kb);
    push(2, vb);
    bytesField(14, entry);
  }
  return Uint8Array.from(out);
}

const METADATA = {
  lfr_window_size: "7",
  lfr_window_shift: "6",
  neg_mean: Array(560).fill("0").join(","),
  inv_stddev: Array(560).fill("1").join(","),
  lang_auto: "0",
  lang_zh: "3",
  lang_en: "4",
  lang_yue: "7",
  lang_ja: "11",
  lang_ko: "12",
  lang_nospeech: "13",
  with_itn: "14",
  without_itn: "15",
};

test("readOnnxMetadataFromBytes skips other fields", async () => {
  const meta = await readOnnxMetadataFromBytes(fakeOnnxModel(METADATA));
  expect(meta.lfr_window_size).toBe("7");
  expect(meta.neg_mean!.split(",").length).toBe(560);
  expect(meta.without_itn).toBe("15");
});

describe("AutoModel", () => {
  function fakeBackend(feedsSeen: Record<string, OnnxTensor>[]): OnnxBackend {
    const session: OnnxSession = {
      inputNames: ["x", "x_length", "language", "text_norm"],
      outputNames: ["logits"],
      async run(feeds) {
        feedsSeen.push(feeds);
        const frames = (feeds.x!.dims[1] as number) + 4;
        const vocab = 9;
        const path = [5, 6, 7, 8, 0, 3, 3, 0, 4];
        const logits = new Float32Array(frames * vocab);
        for (let t = 0; t < frames; t++) logits[t * vocab + (path[t] ?? 0)] = 1;
        return { logits: { type: "float32", data: logits, dims: [1, frames, vocab] } };
      },
      async dispose() {},
    };
    return { name: "fake", createSession: async () => session };
  }

  test("generate runs the model with SenseVoice's inputs", async () => {
    const feeds: Record<string, OnnxTensor>[] = [];
    const model = new AutoModel({
      model: "iic/SenseVoiceSmall",
      modelFile: fakeOnnxModel(METADATA),
      tokens: [
        "<unk>",
        "<s>",
        "</s>",
        "▁hello",
        "▁world",
        "<|en|>",
        "<|NEUTRAL|>",
        "<|Speech|>",
        "<|woitn|>",
      ],
      backend: fakeBackend(feeds),
      shareSession: false,
    });
    const input = new Float32Array(16000).map((_, i) => 0.1 * Math.sin(i / 10));
    const [result] = await model.generate({ input, cache: {}, language: "en", useItn: false });
    expect(result!.text).toBe("<|en|><|NEUTRAL|><|Speech|><|woitn|> hello world");
    expect(richTranscriptionPostprocess(result!.text)).toBe("hello world");

    const f = feeds[0]!;
    expect(f.x!.type).toBe("float32");
    expect(f.x!.dims).toEqual([1, 17, 560]); // ceil(98 / 6)
    expect(f.x_length!.type).toBe("int32");
    expect([...(f.x_length!.data as Int32Array)]).toEqual([17]);
    expect([...(f.language!.data as Int32Array)]).toEqual([4]);
    expect([...(f.text_norm!.data as Int32Array)]).toEqual([15]);

    await model.generate({ input, language: "de", useItn: true });
    expect([...(feeds[1]!.language!.data as Int32Array)]).toEqual([0]);
    expect([...(feeds[1]!.text_norm!.data as Int32Array)]).toEqual([14]);
  });

  test("empty input returns empty text without running the model", async () => {
    const feeds: Record<string, OnnxTensor>[] = [];
    const model = new AutoModel({
      model: "iic/SenseVoiceSmall",
      modelFile: fakeOnnxModel(METADATA),
      tokens: ["<unk>"],
      backend: fakeBackend(feeds),
      shareSession: false,
    });
    expect(await model.generate({ input: new Float32Array(0) })).toEqual([
      { key: "wav_file_tmp_name", text: "" },
    ]);
    expect(feeds.length).toBe(0);
  });

  test("an unknown model name fails to load with a clear error", async () => {
    const model = new AutoModel({ model: "iic/not-a-real-model", backend: fakeBackend([]) });
    await expect(model.load()).rejects.toThrow('Unsupported FunASR model "iic/not-a-real-model"');
  });
});
