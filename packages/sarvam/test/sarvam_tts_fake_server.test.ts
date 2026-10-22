// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * SarvamTTSService and SarvamHttpTTSService against local fake servers
 * (`Bun.serve`) that speak Sarvam's wire format as upstream's code and the
 * `sarvamai` SDK describe it. Not part of upstream's suite: nothing here ran
 * against the real service.
 */

import { expect, test } from "bun:test";
import {
  ErrorFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
} from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { SarvamHttpTTSService, SarvamTTSService } from "../src/tts.ts";

type Dict = Record<string, any>;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

test("test_sarvam_websocket_streams_audio_until_the_final_event", async () => {
  const audio = new Uint8Array(2048).map((_, i) => i % 251);
  const received: Dict[] = [];
  let query = "";
  let apiKey: string | null = null;
  let userAgent: string | null = null;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      query = new URL(request.url).search;
      apiKey = request.headers.get("api-subscription-key");
      userAgent = request.headers.get("User-Agent");
      if (srv.upgrade(request, { data: {} })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        received.push(msg);
        if (msg.type === "text") {
          ws.send(
            JSON.stringify({
              type: "audio",
              data: { content_type: "audio/wav", audio: b64(audio), request_id: "r1" },
            }),
          );
        } else if (msg.type === "flush") {
          ws.send(JSON.stringify({ type: "event", data: { event_type: "final" } }));
        }
      },
    },
  });

  try {
    const tts = new SarvamTTSService({
      apiKey: "test-key",
      url: `ws://127.0.0.1:${server.port}/text-to-speech/ws`,
      settings: new SarvamTTSService.Settings({ model: "bulbul:v3" }),
    });

    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Namaste." }), new SleepFrame({ sleep: 0.4 })],
    });

    const types = down.map((f) => f.constructor);
    expect(types).toContain(TTSStartedFrame);
    expect(types).toContain(TTSStoppedFrame);
    const frames = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.sampleRate).toBe(24000);
    expect(frames[0]!.audio).toEqual(audio);

    expect(new URLSearchParams(query).get("model")).toBe("bulbul:v3");
    expect(query).toContain("send_completion_event=true");
    expect(apiKey).toBe("test-key");
    expect(userAgent as string | null).toContain("Pipedog/");

    expect(received[0]!.type).toBe("config");
    expect(received[0]!.data.speaker).toBe("shubh");
    expect(received[0]!.data.target_language_code).toBe("en-IN");
    expect(received[0]!.data.speech_sample_rate).toBe("24000");
    expect(received[0]!.data.temperature).toBeUndefined();
    const text = received.find((m) => m.type === "text")!;
    expect(text.data.text).toContain("Namaste.");
    expect(received.map((m) => m.type)).toContain("flush");
  } finally {
    server.stop(true);
  }
});

test("test_sarvam_http_strips_the_wav_header_and_posts_the_documented_body", async () => {
  const pcm = new Uint8Array(100).fill(7);
  const wav = new Uint8Array(44 + pcm.length);
  wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  wav.set(pcm, 44);
  const bodies: Dict[] = [];
  const headers: (string | null)[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Dict);
      headers.push(request.headers.get("api-subscription-key"));
      return Response.json({ audios: [b64(wav)], request_id: "r" });
    },
  });

  try {
    const tts = new SarvamHttpTTSService({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    const [down] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Namaste." }), new SleepFrame({ sleep: 0.2 })],
    });

    const frames = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.audio).toEqual(pcm);
    expect(headers[0]).toBe("test-key");
    expect(bodies[0]).toMatchObject({
      target_language_code: "en-IN",
      speaker: "shubh",
      model: "bulbul:v3",
      pace: 1,
      temperature: 0.6,
      enable_preprocessing: true,
    });
    expect("pitch" in bodies[0]!).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("test_sarvam_http_error_status_becomes_an_error_frame", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("quota exceeded", { status: 429 }),
  });

  try {
    const tts = new SarvamHttpTTSService({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}`,
    });
    const [, up] = await runTest(tts, {
      framesToSend: [new TTSSpeakFrame({ text: "Namaste." }), new SleepFrame({ sleep: 0.2 })],
      // The base class adds its own "completed with no audio" error after the first.
      expectedUpFrames: [ErrorFrame, ErrorFrame],
    });
    expect((up[0] as ErrorFrame).error).toContain("Sarvam API error: quota exceeded");
  } finally {
    server.stop(true);
  }
});
