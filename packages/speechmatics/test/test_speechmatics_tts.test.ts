// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for the Speechmatics TTS service against a local fake of the HTTP TTS
 * API (`POST /generate/{voice}?output_format=pcm_16000`). Upstream Pipecat has
 * no test file for this module. The fake is NOT the real service.
 */

import { expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";

import { _getEndpointUrl, SpeechmaticsTTSService } from "../src/tts.ts";

type Any = any;

interface Seen {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Headers;
  body: Any;
}

/** Serve `responses` in order, one per request; the last repeats. */
function fakeTts(responses: (() => Response)[]) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        pathname: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body: await request.json(),
      });
      const make = responses[Math.min(seen.length - 1, responses.length - 1)] as () => Response;
      return make();
    },
  });
  return { server, seen, baseUrl: `http://127.0.0.1:${server.port}` };
}

function pcmResponse(pcm: Uint8Array, splitAt?: number): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (splitAt === undefined) {
        controller.enqueue(pcm);
      } else {
        controller.enqueue(pcm.slice(0, splitAt));
        await sleep(0.01);
        controller.enqueue(pcm.slice(splitAt));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "audio/pcm" } });
}

function concat(frames: TTSAudioRawFrame[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const f of frames) {
    out.set(f.audio, offset);
    offset += f.audio.length;
  }
  return out;
}

const PCM = new Uint8Array(4000).map((_, i) => i % 251);

test("test_endpoint_url", () => {
  const url = _getEndpointUrl("https://preview.tts.speechmatics.com", "sarah", 16000);
  expect(url).toStartWith(
    "https://preview.tts.speechmatics.com/generate/sarah?output_format=pcm_16000&sm-app=pipecat%2F",
  );
});

test("test_missing_api_key_raises", () => {
  expect(() => new SpeechmaticsTTSService({ apiKey: "" })).toThrow();
});

test("test_defaults", () => {
  const service = new SpeechmaticsTTSService({ apiKey: "k" });
  expect((service as Any)._initSampleRate).toBe(16000);
  expect((service as Any)._settings.voice).toBe("sarah");
  expect((service as Any)._settings.maxRetries).toBe(5);
});

test("test_settings_override_defaults", () => {
  const service = new SpeechmaticsTTSService({
    apiKey: "k",
    settings: new SpeechmaticsTTSService.Settings({ voice: "theo", maxRetries: 2 }),
  });
  expect((service as Any)._settings.voice).toBe("theo");
  expect((service as Any)._settings.maxRetries).toBe(2);
});

test("test_request_and_sample_aligned_audio", async () => {
  // The audio is split mid-sample; emitted frames must hold whole 16-bit samples
  // and carry every byte, in order.
  const { server, seen, baseUrl } = fakeTts([() => pcmResponse(PCM, 1001)]);
  let down: Frame[];
  try {
    const service = new SpeechmaticsTTSService({
      apiKey: "secret-key",
      baseUrl,
      settings: new SpeechmaticsTTSService.Settings({ voice: "megan" }),
    });
    [down] = await runTest(service, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello from Speechmatics." })],
    });
  } finally {
    server.stop(true);
  }

  expect(seen.length).toBe(1);
  expect(seen[0]?.method).toBe("POST");
  expect(seen[0]?.pathname).toBe("/generate/megan");
  expect(seen[0]?.query.get("output_format")).toBe("pcm_16000");
  expect(seen[0]?.query.get("sm-app")).toStartWith("pipecat/");
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer secret-key");
  expect(seen[0]?.headers.get("content-type")).toContain("application/json");
  expect(seen[0]?.body).toEqual({ text: "Hello from Speechmatics." });

  const audio = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  expect(audio.length).toBeGreaterThan(0);
  expect(audio.every((f) => f.audio.length % 2 === 0)).toBe(true);
  expect(audio.every((f) => f.sampleRate === 16000 && f.numChannels === 1)).toBe(true);
  expect(concat(audio)).toEqual(PCM);
});

test("test_503_is_retried_then_succeeds", async () => {
  const { server, seen, baseUrl } = fakeTts([
    () => new Response("busy", { status: 503 }),
    () => pcmResponse(PCM),
  ]);
  let up: Frame[];
  let down: Frame[];
  try {
    const service = new SpeechmaticsTTSService({ apiKey: "k", baseUrl });
    [down, up] = await runTest(service, {
      framesToSend: [new TTSSpeakFrame({ text: "Retry me." })],
    });
  } finally {
    server.stop(true);
  }

  expect(seen.length).toBe(2);
  const errors = [...up, ...down].filter((f): f is ErrorFrame => f instanceof ErrorFrame);
  expect(
    errors.some((e) => e.error.startsWith("Service unavailable [503] (attempt 1, retry in")),
  ).toBe(true);
  const audio = down.filter((f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame);
  expect(concat(audio)).toEqual(PCM);
});

/** Run `runTts` directly, for paths that produce no audio (a pipeline would wait out its idle timeout). */
async function collect(service: SpeechmaticsTTSService, text: string): Promise<Frame[]> {
  (service as Any)._sampleRate = 16000;
  const frames: Frame[] = [];
  for await (const frame of service.runTts(text, "ctx-1")) {
    if (frame) frames.push(frame);
  }
  return frames;
}

test("test_503_gives_up_after_max_retries", async () => {
  const { server, seen, baseUrl } = fakeTts([() => new Response("busy", { status: 503 })]);
  let frames: Frame[];
  try {
    const service = new SpeechmaticsTTSService({
      apiKey: "k",
      baseUrl,
      settings: new SpeechmaticsTTSService.Settings({ maxRetries: 1 }),
    });
    frames = await collect(service, "Never works.");
  } finally {
    server.stop(true);
  }

  expect(seen.length).toBe(1);
  expect(frames.map((f) => (f as ErrorFrame).error)).toEqual([
    "Service unavailable [503] (attempts 1)",
  ]);
});

test("test_other_status_is_an_error", async () => {
  const { server, seen, baseUrl } = fakeTts([() => new Response("nope", { status: 401 })]);
  let frames: Frame[];
  try {
    const service = new SpeechmaticsTTSService({ apiKey: "bad", baseUrl });
    frames = await collect(service, "Denied.");
  } finally {
    server.stop(true);
  }

  expect(seen.length).toBe(1);
  expect(frames.map((f) => (f as ErrorFrame).error)).toEqual(["Service unavailable [401]"]);
});
