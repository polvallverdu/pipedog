// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_piper_tts.py

/**
 * Tests for PiperTTSService.
 *
 * Porting notes:
 * - The aiohttp test server is a `Bun.serve` server on a free local port.
 * - `aiohttp_session=session` is not ported (the service takes an optional
 *   `fetch`), so the HTTP tests use the global `fetch`.
 * - The local-voice test needs no `importorskip("piper")`: the engine is part
 *   of this package.
 */

import { describe, expect, test } from "bun:test";
import {
  AggregatedTextFrame,
  ErrorFrame,
  LLMAssistantPushAggregationFrame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
} from "@pipedog/core/frames/frames";
import { runTest } from "@pipedog/core/tests/utils";
import { PiperHttpTTSService, PiperTTSService } from "../src/tts.ts";

function repeat(pattern: number[], times: number): Uint8Array {
  const out = new Uint8Array(pattern.length * times);
  for (let i = 0; i < times; i++) out.set(pattern, i * pattern.length);
  return out;
}

/** An HTTP server answering POST / with `handler`. */
async function withServer<T>(
  handler: (request: Request) => Response | Promise<Response>,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handler(request);
    },
  });
  try {
    // Remove trailing slash if present in the test URL
    return await fn(`http://127.0.0.1:${server.port}/`.replace(/\/+$/, ""));
  } finally {
    server.stop(true);
  }
}

test("test_run_piper_tts_success", async () => {
  // Test successful TTS generation with chunked audio data.
  //
  // Checks frames for TTSStartedFrame -> TTSAudioRawFrame -> TTSStoppedFrame.
  const handler = (request: Request) => {
    // The service expects a /?text= param
    // Here we're just returning dummy chunked bytes to simulate an audio response
    const textQuery = new URL(request.url).searchParams.get("text") ?? "";
    console.log(`Mock server received text param: ${textQuery}`);

    // Prepare a StreamResponse with chunked data
    // In reality, you'd return WAV data or similar
    const CHUNK_SIZE = 24000;
    const dataChunk1 = repeat([0x00, 0x01, 0x02, 0x03], CHUNK_SIZE); // 4xTTSAudioRawFrame
    const dataChunk2 = repeat([0x04, 0x05, 0x06, 0x07], CHUNK_SIZE); // another chunk
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(dataChunk1);
        await Bun.sleep(10); // simulate async chunk delay
        controller.enqueue(dataChunk2);
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "audio/raw" } });
  };

  await withServer(handler, async (baseUrl) => {
    // Instantiate PiperHttpTTSService with our mock server
    const ttsService = new PiperHttpTTSService({ baseUrl, sampleRate: 24000 });

    const framesToSend = [new TTSSpeakFrame({ text: "Hello world." })];

    const framesReceived = await runTest(ttsService, { framesToSend });
    const downFrames = framesReceived[0];
    const frameTypes = downFrames.map((f) => f.constructor);

    // Verify key frames are present
    expect(frameTypes).toContain(AggregatedTextFrame);
    expect(frameTypes).toContain(TTSStartedFrame);
    expect(frameTypes).toContain(TTSStoppedFrame);
    expect(frameTypes).toContain(TTSTextFrame);

    // Verify ordering: Started → audio → Stopped → Text
    const startedIdx = frameTypes.indexOf(TTSStartedFrame);
    const stoppedIdx = frameTypes.indexOf(TTSStoppedFrame);
    const textIdx = frameTypes.indexOf(TTSTextFrame);
    // Expected: TTSStartedFrame < TTSTextFrame < TTSStoppedFrame
    expect(startedIdx < textIdx && textIdx < stoppedIdx).toBe(true);

    // Frames between Started and Stopped must all be audio or text. A
    // LLMAssistantPushAggregationFrame is also expected here: TTSSpeakFrame
    // defaults to appendToContext=true, so the service emits one at the end
    // of the utterance to commit the spoken text to the LLM context.
    for (let i = startedIdx + 1; i < stoppedIdx; i++) {
      expect([TTSAudioRawFrame, TTSTextFrame, LLMAssistantPushAggregationFrame]).toContain(
        frameTypes[i] as never,
      );
    }

    // All audio frames have correct sample rate
    const audioFrames = downFrames.filter(
      (f): f is TTSAudioRawFrame => f instanceof TTSAudioRawFrame,
    );
    expect(audioFrames.length).toBeGreaterThanOrEqual(1);
    for (const aFrame of audioFrames) {
      // Sample rate should match the default (24000)
      expect(aFrame.sampleRate).toBe(24000);
    }
  });
});

test("test_run_piper_tts_error", async () => {
  // Test how the service handles a non-200 response from the server.
  //
  // Expects an ErrorFrame to be returned.
  const handler = () => new Response("Not found", { status: 404 });

  await withServer(handler, async (baseUrl) => {
    const ttsService = new PiperHttpTTSService({ baseUrl, sampleRate: 24000 });

    const framesToSend = [new TTSSpeakFrame({ text: "Error case.", appendToContext: false })];

    const expectedDownFrames = [
      AggregatedTextFrame,
      TTSStartedFrame,
      TTSStoppedFrame,
      TTSTextFrame,
    ];

    // The 404, then the context completing with no audio.
    const expectedUpFrames = [ErrorFrame, ErrorFrame];

    const framesReceived = await runTest(ttsService, {
      framesToSend,
      expectedDownFrames,
      expectedUpFrames,
    });
    const upFrames = framesReceived[1];

    // Must receive an ErrorFrame for 404
    expect(upFrames[0]).toBeInstanceOf(ErrorFrame);
    // ErrorFrame should contain details about the 404
    expect((upFrames[0] as ErrorFrame).error).toContain("status: 404");
  });
});

describe("test_local_piper_rejects_a_missing_or_blank_voice_before_downloading", () => {
  for (const [id, voice] of [
    ["none", null],
    ["blank", ""],
  ] as const) {
    test(id, () => {
      expect(
        () => new PiperTTSService({ settings: new PiperTTSService.Settings({ voice }) }),
      ).toThrow("Piper TTS voice must be specified");
    });
  }
});
