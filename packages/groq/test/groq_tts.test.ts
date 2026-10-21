// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// GroqTTSService against a local stand-in for Groq's /audio/speech endpoint.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { pcmToWav } from "@pipedog/core/audio/utils";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { GroqTTSService } from "../src/tts.ts";

const PCM = new Uint8Array(4800).map((_, i) => i % 251);

let server: ReturnType<typeof Bun.serve>;
const requests: { path: string; authorization: string | null; body: any }[] = [];
let failNext = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      if (failNext) {
        failNext = false;
        return Response.json({ error: { message: "bad voice" } }, { status: 400 });
      }
      const wav = pcmToWav(PCM, 48000, 1);
      return new Response(wav, { headers: { "Content-Type": "audio/wav" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

function audioFrames(frames: Frame[]): TTSAudioRawFrame[] {
  return frames.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
}

test("sends the speech request and pushes the WAV's audio", async () => {
  const tts = new GroqTTSService({
    apiKey: "groq-key",
    baseUrl: `http://127.0.0.1:${server.port}/openai/v1`,
    sampleRate: 48000,
  });

  const [down] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Hello from Groq." })],
  });

  const request = requests.at(-1)!;
  expect(request.path).toBe("/openai/v1/audio/speech");
  expect(request.authorization).toBe("Bearer groq-key");
  expect(request.body).toEqual({
    model: "canopylabs/orpheus-v1-english",
    voice: "autumn",
    response_format: "wav",
    speed: 1.0,
    input: "Hello from Groq.",
  });

  const frames = audioFrames(down);
  expect(frames.length).toBeGreaterThan(0);
  const audio = new Uint8Array(frames.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const f of frames) {
    audio.set(f.audio, offset);
    offset += f.audio.length;
  }
  expect(audio).toEqual(PCM);
  expect(frames[0]!.sampleRate).toBe(48000);
});

test("settings override the model and voice", async () => {
  const tts = new GroqTTSService({
    apiKey: "groq-key",
    baseUrl: `http://127.0.0.1:${server.port}/openai/v1`,
    sampleRate: 48000,
    settings: new GroqTTSService.Settings({ voice: "diana", model: "other-model" }),
  });

  await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi" })] });

  expect(requests.at(-1)!.body.voice).toBe("diana");
  expect(requests.at(-1)!.body.model).toBe("other-model");
});

test("an API error becomes an ErrorFrame", async () => {
  failNext = true;
  const tts = new GroqTTSService({
    apiKey: "groq-key",
    baseUrl: `http://127.0.0.1:${server.port}/openai/v1`,
    sampleRate: 48000,
  });

  const [, up] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi" })] });

  const errors = up.filter((f): f is ErrorFrame => f instanceof ErrorFrame);
  // The base class then reports the audio context that produced no audio.
  expect(errors.length).toBeGreaterThanOrEqual(1);
  expect(errors[0]!.error).toContain("Unknown error occurred");
  expect(errors[0]!.error).toContain("400");
});
