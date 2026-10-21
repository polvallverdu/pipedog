// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// MistralTTSService against a local stand-in for Mistral's streaming
// /v1/audio/speech endpoint (Server-Sent Events with float32 PCM).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { MistralTTSService } from "../src/tts.ts";

function float32Bytes(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    view.setFloat32(i * 4, v, true);
  });
  return out;
}

function int16Values(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true));
}

const CHUNK_A = [0, 0.5, -0.5, 1, -1];
const CHUNK_B = [2, -2, 0.25];

let server: ReturnType<typeof Bun.serve>;
const requests: {
  path: string;
  authorization: string | null;
  accept: string | null;
  body: any;
}[] = [];
let failNext = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
        body: await request.json(),
      });
      if (failNext) {
        failNext = false;
        return Response.json({ message: "invalid voice" }, { status: 422 });
      }
      const encoder = new TextEncoder();
      const event = (data: Record<string, unknown>) =>
        encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const a = event({
            type: "speech.audio.delta",
            audio_data: bytesToBase64(float32Bytes(CHUNK_A)),
          });
          // Split an event across reads.
          controller.enqueue(a.slice(0, 10));
          await sleep(0.01);
          controller.enqueue(a.slice(10));
          controller.enqueue(
            event({ type: "speech.audio.delta", audio_data: bytesToBase64(float32Bytes(CHUNK_B)) }),
          );
          controller.enqueue(event({ type: "speech.audio.done", usage: { total_tokens: 3 } }));
          controller.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

function audioFrames(frames: Frame[]): TTSAudioRawFrame[] {
  return frames.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
}

test("streams the speech request and converts float32 PCM to int16", async () => {
  const tts = new MistralTTSService({
    apiKey: "mistral-key",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    sampleRate: 24000,
    settings: new MistralTTSService.Settings({ voice: "voice-1" }),
  });

  const [down] = await runTest(tts, {
    framesToSend: [new TTSSpeakFrame({ text: "Bonjour." })],
  });

  const request = requests.at(-1)!;
  expect(request.path).toBe("/v1/audio/speech");
  expect(request.authorization).toBe("Bearer mistral-key");
  // As the SDK asks for a stream (audioSpeechComplete: Accept text/event-stream).
  expect(request.accept).toBe("text/event-stream");
  expect(request.body).toEqual({
    input: "Bonjour.",
    model: "voxtral-mini-tts-2603",
    voice_id: "voice-1",
    response_format: "pcm",
    stream: true,
  });

  const frames = audioFrames(down);
  const samples = frames.flatMap((f) => int16Values(f.audio));
  expect(samples).toEqual([0, 16383, -16383, 32767, -32767, 32767, -32768, 8191]);
  expect(frames.every((f) => f.sampleRate === 24000 && f.numChannels === 1)).toBe(true);
});

test("_float32ToInt16 clamps and truncates like upstream", () => {
  const out = MistralTTSService._float32ToInt16(float32Bytes([0.99999, -0.00001, 3]));
  expect(int16Values(out)).toEqual([32766, 0, 32767]);
});

test("an API error becomes an ErrorFrame", async () => {
  failNext = true;
  const tts = new MistralTTSService({
    apiKey: "mistral-key",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    sampleRate: 24000,
  });

  const [, up] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi" })] });

  const errors = up.filter((f): f is ErrorFrame => f instanceof ErrorFrame);
  expect(errors.length).toBeGreaterThanOrEqual(1);
  expect(errors[0]!.error).toContain("Error generating TTS");
  expect(errors[0]!.error).toContain("422");
});
