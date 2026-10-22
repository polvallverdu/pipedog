// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: exercises the Moonshine catalog and
// MoonshineSTTService end to end (VAD segmentation, greedy decoding,
// tokenizer, TranscriptionFrame) on a fake ONNX backend with in-memory model
// files, so nothing is downloaded. Real inference is covered by
// test/e2e_moonshine.test.ts.

import {
  getModelForLanguage,
  Model,
  ModelArch,
  MoonshineSTTService,
  MoonshineSTTSettings,
  stringToModelArch,
  supportedLanguages,
} from "@pipedog/moonshine";
import type { OnnxBackend, OnnxModelSource, OnnxSession, OnnxTensor } from "@pipedog/onnx";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`moonshine smoke: ${message}`);
}

// 0 <unk>, 1 <s>, 2 </s>, 3 ▁hello, 4 ▁world
const VOCAB = ["<unk>", "<s>", "</s>", "▁hello", "▁world"];

function tokenizerBytes(): Uint8Array {
  const out: number[] = [];
  for (const entry of VOCAB) {
    const bytes = new TextEncoder().encode(entry);
    out.push(bytes.length, ...bytes);
  }
  return Uint8Array.from(out);
}

function tensor(data: Float32Array, dims: number[]): OnnxTensor {
  return { type: "float32", data, dims };
}

function session(
  inputNames: string[],
  outputNames: string[],
  run: (feeds: Record<string, OnnxTensor>) => Record<string, OnnxTensor>,
): OnnxSession {
  return { inputNames, outputNames, run: async (feeds) => run(feeds), dispose: async () => {} };
}

function fakeBackend(encoderBytes: Uint8Array, decoderBytes: Uint8Array): OnnxBackend {
  const layers: string[] = [];
  for (let i = 0; i < 6; i++) {
    for (const s of ["decoder.key", "decoder.value", "encoder.key", "encoder.value"]) {
      layers.push(`${i}.${s}`);
    }
  }
  const script = [3, 4, 2];
  let step = 0;
  return {
    name: "fake",
    async createSession(model: OnnxModelSource) {
      if (model === encoderBytes) {
        return session(["input_values"], ["last_hidden_state"], () => ({
          last_hidden_state: tensor(new Float32Array(2), [1, 1, 2]),
        }));
      }
      if (model === decoderBytes) {
        return session(
          [
            "input_ids",
            "encoder_hidden_states",
            ...layers.map((l) => `past_key_values.${l}`),
            "use_cache_branch",
          ],
          ["logits", ...layers.map((l) => `present.${l}`)],
          () => {
            const logits = new Float32Array(VOCAB.length);
            logits[script[step++ % script.length] as number] = 1;
            const out: Record<string, OnnxTensor> = {
              logits: tensor(logits, [1, 1, VOCAB.length]),
            };
            for (const l of layers) out[`present.${l}`] = tensor(new Float32Array(1), [1, 1, 1, 1]);
            return out;
          },
        );
      }
      // Silero VAD: always speech.
      return session(["input", "state", "sr"], ["output", "stateN"], () => ({
        output: tensor(Float32Array.of(0.9), [1, 1]),
        stateN: tensor(new Float32Array(256), [2, 1, 128]),
      }));
    },
  };
}

export default async function smoke(): Promise<void> {
  check(supportedLanguages().includes("en"), "languages");
  check(stringToModelArch("tiny") === ModelArch.TINY, "arch");
  const [path, arch] = getModelForLanguage("uk", null, { cacheRoot: "/moonshine-cache" });
  check(arch === ModelArch.BASE, `uk default arch ${arch}`);
  check(path.endsWith("download.moonshine.ai/model/base-uk/quantized/base-uk"), path);

  const encoder = new Uint8Array(1);
  const decoder = new Uint8Array(1);
  const service = new MoonshineSTTService({
    cacheRoot: "/moonshine-cache",
    settings: new MoonshineSTTSettings({ model: Model.TINY }),
    transcriberOptions: {
      backend: fakeBackend(encoder, decoder),
      files: {
        "encoder_model.ort": encoder,
        "decoder_model_merged.ort": decoder,
        "tokenizer.bin": tokenizerBytes(),
      },
    },
  });
  check(service.canGenerateMetrics(), "metrics");

  // One second of 16-bit PCM.
  const frames = [];
  for await (const frame of service.runStt(new Uint8Array(32000))) frames.push(frame);
  check(frames.length === 1, `frames ${frames.length}`);
  const text = (frames[0] as { text?: string }).text;
  check(text === "hello world", `text ${text}`);
}
