// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: runs the Pocket TTS engine (text
// chunking, voice-state import, the autoregressive flow loop, LSD sampling,
// streaming Mimi decoding) on fake ONNX sessions, and PocketTTSService on top
// of it, so nothing is downloaded. Real inference is covered by
// test/e2e_pocket_tts.test.ts.

import { ErrorFrame, TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import type { OnnxSession, OnnxTensor } from "@pipedog/onnx";
import {
  languageToPocketTtsLanguage,
  type PocketTTSBundleMetadata,
  PocketTTSService,
  prepareTextPrompt,
  type TextTokenizer,
  TTSModel,
} from "@pipedog/pocket-tts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`pocket-tts smoke: ${message}`);
}

const LDIM = 2;
const DIM = 4;
const MODULE = "transformer.layers.0.self_attn";

const metadata: PocketTTSBundleMetadata = {
  sample_rate: 24000,
  frame_rate: 12.5,
  samples_per_frame: 4,
  latent_dim: LDIM,
  conditioning_dim: DIM,
  insert_bos_before_voice: true,
  flow_lm_state_manifest: [
    {
      index: 0,
      input_name: "state_0",
      output_name: "out_state_0",
      module: MODULE,
      key: "cache",
      shape: [2, 1, 256, 1, DIM],
      dtype: "float32",
      fill: "nan",
    },
    {
      index: 1,
      input_name: "state_1",
      output_name: "out_state_1",
      module: MODULE,
      key: "step",
      shape: [1],
      dtype: "int64",
      fill: "zeros",
    },
  ],
  mimi_state_manifest: [],
};

const tokenizer: TextTokenizer = {
  encode: (text) => [1000, ...Array.from(text, (c) => c.codePointAt(0)!)],
  decode: (ids) =>
    ids
      .filter((i) => i !== 1000)
      .map((i) => String.fromCodePoint(i))
      .join("")
      .replace(/^ /, ""),
};

function f32(data: Float32Array, dims: number[]): OnnxTensor {
  return { type: "float32", data, dims };
}

function session(
  outputNames: string[],
  run: (feeds: Record<string, OnnxTensor>) => Record<string, OnnxTensor>,
): OnnxSession {
  return { inputNames: [], outputNames, run: async (f) => run(f), dispose: async () => {} };
}

function voiceState(length: number): Uint8Array {
  const cache = new Float32Array(2 * length * DIM);
  const header = new TextEncoder().encode(
    JSON.stringify({
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
    }),
  );
  const out = new Uint8Array(8 + header.length + cache.byteLength + 8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(header.length), true);
  out.set(header, 8);
  view.setBigInt64(8 + header.length + cache.byteLength, BigInt(length), true);
  return out;
}

function fakeModel(): TTSModel {
  let arSteps = 0;
  return new TTSModel({
    language: "english",
    metadata,
    tokenizer,
    temp: 0.7,
    sessions: {
      textConditioner: session(["e"], (feeds) => {
        const n = feeds.token_ids!.dims[1]!;
        return { e: f32(new Float32Array(n * DIM), [1, n, DIM]) };
      }),
      flowLmMain: session(["conditioning", "eos_logit"], (feeds) => {
        const step = (feeds.state_1!.data as BigInt64Array)[0]!;
        const seqLen = feeds.sequence!.dims[1]!;
        const textLen = feeds.text_embeddings!.dims[1]!;
        if (textLen > 0) arSteps = 0;
        const eos = seqLen === 1 && arSteps++ >= 2 ? 0 : -10;
        return {
          conditioning: f32(new Float32Array(DIM), [1, DIM]),
          eos_logit: f32(Float32Array.of(eos), [1, 1]),
          out_state_0: feeds.state_0!,
          out_state_1: {
            type: "int64",
            data: BigInt64Array.of(step + BigInt(seqLen + textLen)),
            dims: [1],
          },
        };
      }),
      flowLmFlow: session(["flow"], () => ({
        flow: f32(new Float32Array(LDIM).fill(0.25), [1, LDIM]),
      })),
      mimiDecoder: session(["audio_frame"], (feeds) => {
        const latent = feeds.latent!.data as Float32Array;
        return { audio_frame: f32(new Float32Array(4).fill(Math.tanh(latent[0]!)), [1, 1, 4]) };
      }),
    },
    loadPredefinedVoice: async () => voiceState(3),
  });
}

export default async function smoke(): Promise<void> {
  check(languageToPocketTtsLanguage("fr-CA" as never) === "french_24l", "fr-CA");
  check(prepareTextPrompt("hello", false, false)[0] === "Hello.", "prepareTextPrompt");

  // The engine on its own.
  const model = fakeModel();
  const state = await model.getStateForAudioPrompt("alba");
  const audio = await model.generateAudio(state, "Hello there. How are you?", { maxTokens: 16 });
  // Two chunks of up to 16 tokens, each: EOS at step 2, then 1 + 2 frames
  // ("Hello there." is two words: 3 + 2), 4 samples per frame.
  check(audio.length === (2 + 5 + (2 + 5)) * 4, `samples ${audio.length}`);

  // PocketTTSService on the engine (loadModel swapped for the fake model).
  const loadModel = TTSModel.loadModel;
  TTSModel.loadModel = async () => fakeModel();
  try {
    const service = new PocketTTSService({ sampleRate: 24000 });
    check(service.canGenerateMetrics(), "metrics");
    const [down] = await runTest(service, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });
    check(!down.some((f) => f instanceof ErrorFrame), "error frame");
    const bytes = down
      .filter((f) => f instanceof TTSAudioRawFrame)
      .reduce((n, f) => n + (f as TTSAudioRawFrame).audio.length, 0);
    // "Hi.": EOS at step 2, then 3 + 2 frames of 4 samples, 16-bit.
    check(bytes === (2 + 5) * 4 * 2, `service bytes ${bytes}`);
  } finally {
    TTSModel.loadModel = loadModel;
  }
}
