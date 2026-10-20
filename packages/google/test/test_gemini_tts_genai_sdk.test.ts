// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * GeminiTTSService's Gemini API backend through the real `@google/genai`
 * client, against a local HTTP server answering `streamGenerateContent` with
 * server-sent events that carry base64 `inlineData` audio.
 *
 * Compared with upstream pipecat (google-genai 2.31 for Python) against the
 * same fake: the same path, query, contents and generation config, and the
 * same frames. The Python SDK writes the nested speech config keys in
 * snake_case (`voice_config`), the JS SDK in camelCase; both are valid proto
 * JSON.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { GeminiTTSService, GeminiTTSSettings } from "../src/tts.ts";
import { type FakeGenaiServer, startFakeGenaiServer } from "./google_fakes.ts";

const PCM = Uint8Array.from({ length: 1500 }, (_, i) => (i * 7) & 0xff);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/** A 44-byte RIFF/WAVE header (24 kHz, mono, 16-bit) for `dataLength` bytes. */
function wavHeader(dataLength: number): Uint8Array {
  const h = new Uint8Array(44);
  const v = new DataView(h.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) h[o + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true);
  v.setUint32(28, 48000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, dataLength, true);
  return h;
}

const chunk = (data: Uint8Array, finish = false) => ({
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: b64(data) } }],
      },
      ...(finish ? { finishReason: "STOP" } : {}),
    },
  ],
});

let server: FakeGenaiServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const audioOf = (frames: Frame[]) => {
  const chunks = frames.filter((f) => f instanceof TTSAudioRawFrame) as TTSAudioRawFrame[];
  const out = new Uint8Array(chunks.reduce((n, f) => n + f.audio.length, 0));
  let o = 0;
  for (const f of chunks) {
    out.set(f.audio, o);
    o += f.audio.length;
  }
  return { chunks, audio: out };
};

describe("GeminiTTSService (Gemini API backend) over @google/genai", () => {
  test("default model: request and streamed PCM", async () => {
    server = startFakeGenaiServer({
      streamGenerateContent: () => [chunk(PCM.subarray(0, 600)), chunk(PCM.subarray(600), true)],
    });
    const tts = new GeminiTTSService({ apiKey: "test-key", httpOptions: { baseUrl: server.url } });
    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello world." })],
    });

    expect(server.requests).toHaveLength(1);
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1beta/models/gemini-3.1-flash-tts-preview:streamGenerateContent");
    expect(req.query).toEqual({ alt: "sse" });
    expect(req.headers["x-goog-api-key"]).toBe("test-key");
    expect(req.body).toEqual({
      contents: [{ role: "user", parts: [{ text: "Hello world." }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: "en-US",
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
        },
      },
    });
    const { chunks, audio } = audioOf(down);
    expect(audio).toEqual(PCM);
    expect(chunks.every((f) => f.sampleRate === 24000 && f.numChannels === 1)).toBe(true);
  });

  test("Gemini 3.8: prompt as speechMetadata, WAV header stripped", async () => {
    const wav = new Uint8Array(44 + PCM.length);
    wav.set(wavHeader(PCM.length));
    wav.set(PCM, 44);
    server = startFakeGenaiServer({
      streamGenerateContent: () => [chunk(wav.subarray(0, 500)), chunk(wav.subarray(500), true)],
    });
    const tts = new GeminiTTSService({
      apiKey: "test-key",
      httpOptions: { baseUrl: server.url },
      settings: new GeminiTTSSettings({
        model: "gemini-3.8-flash-tts",
        voice: "Charon",
        prompt: "Whisper",
      }),
    });
    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello world." })],
    });

    const req = server.requests[0]!;
    expect(req.path).toBe("/v1beta/models/gemini-3.8-flash-tts:streamGenerateContent");
    expect(req.body).toEqual({
      contents: [
        { role: "user", parts: [{ text: "Hello world.", speechMetadata: { style: "Whisper" } }] },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: "en-US",
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
        },
      },
    });
    expect(audioOf(down).audio).toEqual(PCM);
  });

  test("an API error becomes an ErrorFrame", async () => {
    server = startFakeGenaiServer({
      streamGenerateContent: () =>
        new Response(
          JSON.stringify({
            error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    const tts = new GeminiTTSService({ apiKey: "bad", httpOptions: { baseUrl: server.url } });
    const [, up] = await runTest(tts, { framesToSend: [new TTSSpeakFrame({ text: "Hi." })] });
    const errors = up.filter((f) => f instanceof ErrorFrame) as ErrorFrame[];
    expect(errors[0]?.error).toStartWith("Gemini GenAI TTS generation error:");
    expect(errors[0]?.error).toContain("API key not valid.");
  });

  test("an interruption aborts the HTTP stream", async () => {
    let cancelled = false;
    server = startFakeGenaiServer({
      streamGenerateContent: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // One chunk, then keep the response open like a long utterance.
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(chunk(PCM))}\r\n\r\n`),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const tts = new GeminiTTSService({ apiKey: "test-key", httpOptions: { baseUrl: server.url } });
    await runTest(tts, {
      framesToSend: [
        new TTSSpeakFrame({ text: "A long sentence." }),
        new SleepFrame({ sleep: 0.3 }),
        new InterruptionFrame(),
        new SleepFrame({ sleep: 0.3 }),
      ],
    });
    expect(server.requests).toHaveLength(1);
    expect(cancelled).toBe(true);
  });
});
