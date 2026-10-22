// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat, without downloading any model.
//
// BaseWhisperSTTService (the Whisper-API client, through the openai SDK)
// against a fake fetch, the probability helpers in utils, and the local
// services (`@pipedog/whisper/stt`) with a fake ONNX backend and in-memory
// model files: features, tokenizer, prompt, decoding loop and segment
// filtering all run for real. That the local services' code runs on workerd
// says nothing about real models there: they don't fit a Worker's memory.

import { ErrorFrame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import {
  BaseWhisperSTTService,
  extractDeepgramProbability,
  extractWhisperProbability,
  type Transcription,
} from "@pipedog/whisper";
import { WhisperSTTService, WhisperSTTServiceMLX } from "@pipedog/whisper/stt";
import { fakeWhisperBackend, fakeWhisperFiles } from "../test/fake_whisper.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`whisper smoke: ${message}`);
}

async function frames(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

class ApiWhisper extends BaseWhisperSTTService {
  protected override async _transcribe(audio: Uint8Array): Promise<Transcription> {
    const { toFile } = await import("openai");
    return (await this._client.audio.transcriptions.create({
      file: await toFile(audio, "audio.wav", { type: "audio/wav" }),
      model: "whisper-1",
    })) as Transcription;
  }
}

function tonePcm(seconds: number): Uint8Array {
  const n = Math.round(16000 * seconds);
  const pcm = new Uint8Array(n * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < n; i++) {
    view.setInt16(i * 2, Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / 16000)), true);
  }
  return pcm;
}

export default async function smoke(): Promise<void> {
  // The Whisper API base class over a fake endpoint.
  let requests = 0;
  const api = new ApiWhisper({
    apiKey: "test",
    baseUrl: "http://whisper.invalid/v1",
    httpClient: (async (url: unknown) => {
      // The SDK also fetches a `data:` URL to probe FormData support.
      if (String(url).endsWith("/audio/transcriptions")) requests++;
      return new Response(JSON.stringify({ text: "hello there" }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const apiFrames = await frames(api.runStt(new Uint8Array(64)));
  check(requests === 1, `api requests ${requests}`);
  const apiText = apiFrames.find((f) => f instanceof TranscriptionFrame) as TranscriptionFrame;
  check(apiText?.text === "hello there", `api transcript ${JSON.stringify(apiFrames)}`);

  const verbose = new TranscriptionFrame({
    text: "x",
    userId: "u",
    timestamp: "t",
    result: { segments: [{ avg_logprob: 0 }] },
  });
  check(extractWhisperProbability(verbose) === 1, "whisper probability");
  const dg = new TranscriptionFrame({
    text: "x",
    userId: "u",
    timestamp: "t",
    result: { channel: { alternatives: [{ confidence: 0.5 }] } },
  });
  check(extractDeepgramProbability(dg) === 0.5, "deepgram probability");

  // Local Whisper with a fake engine (no ONNX runtime, no files).
  const modelOptions = {
    files: fakeWhisperFiles(),
    backend: fakeWhisperBackend(),
    shareSession: false,
  };

  const local = new WhisperSTTService({
    settings: new WhisperSTTService.Settings({ model: "tiny" }),
    modelOptions,
  });
  const localFrames = await frames(local.runStt(tonePcm(1)));
  const errors = localFrames.filter((f) => f instanceof ErrorFrame);
  check(errors.length === 0, `local errors ${JSON.stringify(errors)}`);
  const localText = localFrames.find((f) => f instanceof TranscriptionFrame) as TranscriptionFrame;
  check(localText?.text.trim() === "Hello world.", `local transcript ${localText?.text}`);
  const silence = await frames(local.runStt(new Uint8Array(32000)));
  check(silence.length === 0, `silence frames ${silence.length}`);

  const mlx = new WhisperSTTServiceMLX({ modelOptions });
  const mlxFrames = await frames(mlx.runStt(tonePcm(1)));
  const mlxText = mlxFrames.find((f) => f instanceof TranscriptionFrame) as TranscriptionFrame;
  check(mlxText?.text.trim() === "Hello world.", `mlx transcript ${JSON.stringify(mlxFrames)}`);
}
