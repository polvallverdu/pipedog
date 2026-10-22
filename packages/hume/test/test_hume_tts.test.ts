// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for HumeTTSService.
 *
 * Upstream has no test file for Hume. These tests serve Hume's
 * `POST /v0/tts/stream/json` endpoint (newline-delimited JSON, see the
 * module header of `src/tts.ts`) with `Bun.serve` and check the request the
 * service sends and the frames it produces.
 */

import { describe, expect, test } from "bun:test";
import { ErrorFrame, TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import { HUME_SAMPLE_RATE, HumeTTSService } from "../src/tts.ts";

// Tests reach into protected members.
type Any = any;

interface Captured {
  headers: Headers;
  body: Any;
}

function humeServer(respond: (captured: Captured) => Response): {
  url: string;
  requests: Captured[];
  stop: () => void;
} {
  const requests: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v0/tts/stream/json") {
        return new Response("not found", { status: 404 });
      }
      const captured = { headers: request.headers, body: await request.json() };
      requests.push(captured);
      return respond(captured);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

const audioLine = (bytes: Uint8Array) =>
  `${JSON.stringify({ type: "audio", audio: bytesToBase64(bytes), is_last_chunk: false })}\n`;
const wordLine = (text: string, begin: number, end: number) =>
  `${JSON.stringify({ type: "timestamp", timestamp: { type: "word", text, time: { begin, end } } })}\n`;

function ndjson(lines: string[], splitAt = 0): Response {
  const whole = lines.join("");
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-line to check that chunk boundaries do not matter.
      if (splitAt > 0) {
        controller.enqueue(encoder.encode(whole.slice(0, splitAt)));
        controller.enqueue(encoder.encode(whole.slice(splitAt)));
      } else {
        controller.enqueue(encoder.encode(whole));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
}

describe("TestHumeTTS", () => {
  test("test_requires_an_api_key", () => {
    const saved = process.env.HUME_API_KEY;
    delete process.env.HUME_API_KEY;
    try {
      expect(() => new HumeTTSService()).toThrow(/requires an API key/);
    } finally {
      if (saved !== undefined) process.env.HUME_API_KEY = saved;
    }
  });

  test("test_api_key_from_environment", () => {
    const saved = process.env.HUME_API_KEY;
    process.env.HUME_API_KEY = "env-key";
    try {
      const service: Any = new HumeTTSService();
      expect(service._apiKey).toBe("env-key");
      expect(service._initSampleRate).toBe(HUME_SAMPLE_RATE);
    } finally {
      if (saved === undefined) delete process.env.HUME_API_KEY;
      else process.env.HUME_API_KEY = saved;
    }
  });

  test("test_request_body_and_headers", async () => {
    const server = humeServer(() => ndjson([audioLine(new Uint8Array(4))]));
    try {
      const service = new HumeTTSService({
        apiKey: "test-key",
        baseUrl: server.url,
        settings: new HumeTTSService.Settings({
          voice: "voice-1",
          speed: 1.2,
          trailingSilence: 0.5,
          temperature: 0.6,
        }),
      });
      await runTest(service, { framesToSend: [new TTSSpeakFrame({ text: "Hello." })] });
    } finally {
      server.stop();
    }

    expect(server.requests.length).toBe(1);
    const { headers, body } = server.requests[0]!;
    expect(headers.get("x-hume-api-key")).toBe("test-key");
    expect(headers.get("x-hume-client-name")).toBe("pipedog");
    expect(body).toEqual({
      utterances: [
        {
          text: "Hello.",
          voice: { id: "voice-1" },
          speed: 1.2,
          trailing_silence: 0.5,
        },
      ],
      format: { type: "pcm" },
      instant_mode: true,
      version: "2",
      include_timestamp_types: ["word"],
      temperature: 0.6,
    });
  });

  test("test_description_selects_octave_version_1", async () => {
    const server = humeServer(() => ndjson([audioLine(new Uint8Array(4))]));
    try {
      const service = new HumeTTSService({
        apiKey: "test-key",
        baseUrl: server.url,
        settings: new HumeTTSService.Settings({ voice: "voice-1", description: "calm" }),
      });
      await runTest(service, { framesToSend: [new TTSSpeakFrame({ text: "Hello." })] });
    } finally {
      server.stop();
    }

    const { body } = server.requests[0]!;
    expect(body.version).toBe("1");
    expect(body.utterances[0].description).toBe("calm");
    expect("temperature" in body).toBe(false);
  });

  test("test_audio_is_buffered_and_flushed_with_word_timestamps", async () => {
    const chunkA = new Uint8Array(1000).fill(1);
    const chunkB = new Uint8Array(1000).fill(2);
    const server = humeServer(() =>
      ndjson(
        [
          audioLine(chunkA),
          wordLine("Hello", 0, 400),
          audioLine(chunkB),
          wordLine("there", 400, 900),
        ],
        137,
      ),
    );
    let downFrames: any[];
    let service: Any;
    const timestamps: [[string, number][], string][] = [];
    try {
      service = new HumeTTSService({
        apiKey: "test-key",
        baseUrl: server.url,
        settings: new HumeTTSService.Settings({ voice: "voice-1" }),
      });
      service.addWordTimestamps = async (wordTimes: [string, number][], contextId: string) => {
        timestamps.push([wordTimes, contextId]);
      };
      [downFrames] = await runTest(service, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello there." })],
      });
    } finally {
      server.stop();
    }

    const audio = downFrames
      .filter((f) => f instanceof TTSAudioRawFrame)
      .flatMap((f: TTSAudioRawFrame) => Array.from(f.audio));
    expect(audio).toEqual([...chunkA, ...chunkB]);
    expect(timestamps.map(([pairs]) => pairs)).toEqual([[["Hello", 0]], [["there", 0.4]]]);
  });

  test("test_missing_voice_is_an_error", async () => {
    const server = humeServer(() => ndjson([]));
    let upFrames: any[];
    try {
      const service = new HumeTTSService({
        apiKey: "test-key",
        baseUrl: server.url,
        stopFrameTimeoutS: 0.1,
      });
      [, upFrames] = await runTest(service, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello." })],
      });
    } finally {
      server.stop();
    }

    expect(server.requests.length).toBe(0);
    const errors = upFrames.filter((f) => f instanceof ErrorFrame);
    expect(errors.some((f) => f.error.includes("voice must be specified"))).toBe(true);
  });

  test("test_http_error_is_reported", async () => {
    const server = humeServer(() => new Response('{"detail":[]}', { status: 422 }));
    let upFrames: any[];
    try {
      const service = new HumeTTSService({
        apiKey: "test-key",
        baseUrl: server.url,
        stopFrameTimeoutS: 0.1,
        settings: new HumeTTSService.Settings({ voice: "voice-1" }),
      });
      [, upFrames] = await runTest(service, {
        framesToSend: [new TTSSpeakFrame({ text: "Hello." })],
      });
    } finally {
      server.stop();
    }

    const errors = upFrames.filter((f) => f instanceof ErrorFrame);
    expect(errors.some((f) => f.error.includes("422"))).toBe(true);
  });
});
