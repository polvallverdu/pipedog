// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_deepgram_tts.py

/** Unit tests for the Deepgram TTS services. */

import { expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import { type Frame, TTSAudioRawFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { runTest } from "@pipedog/core/tests/utils";

import { DeepgramHttpTTSService, DeepgramTTSService } from "../src/tts.ts";

/**
 * Stands in for `websockets.exceptions.InvalidStatus`, the exception
 * `websockets` raises when a handshake is rejected: it carries the HTTP
 * response with its status code.
 */
class InvalidStatus extends Error {
  response: { status_code: number };

  constructor(response: { status_code: number }) {
    super(`server rejected WebSocket connection: HTTP ${response.status_code}`);
    this.name = "InvalidStatus";
    this.response = response;
  }
}

/** Build the exception `websockets` raises when a handshake is rejected. */
function websocketRejection(statusCode: number): InvalidStatus {
  return new InvalidStatus({ status_code: statusCode });
}

/**
 * Upstream monkeypatches `pipecat.services.websocket_service.websocket_connect`;
 * here the service's `_websocketConnect` (the mixin's wrapper around it) is
 * replaced on the instance.
 */
function patchWebsocketConnect(
  service: DeepgramTTSService,
  fake: (...args: unknown[]) => Promise<never>,
): void {
  (service as unknown as { _websocketConnect: typeof fake })._websocketConnect = fake;
}

test("test_deepgram_rejected_api_key_makes_the_service_unusable", async () => {
  const fakeWebsocketConnect = async (..._args: unknown[]): Promise<never> => {
    throw websocketRejection(401);
  };

  const service = new DeepgramTTSService({ apiKey: "wrong-key", sampleRate: 24000 });
  patchWebsocketConnect(service, fakeWebsocketConnect);

  await service._connectWebsocket();

  expect(service.isUsable).toBe(false);
});

test("test_deepgram_server_error_leaves_the_service_usable", async () => {
  const fakeWebsocketConnect = async (..._args: unknown[]): Promise<never> => {
    throw websocketRejection(503);
  };

  const service = new DeepgramTTSService({ apiKey: "test-key", sampleRate: 24000 });
  patchWebsocketConnect(service, fakeWebsocketConnect);

  await service._connectWebsocket();

  expect(service.isUsable).toBe(true);
});

/** HTTP TTS audio frames hold whole 16-bit samples however the stream is split. */
test("test_deepgram_http_frames_stay_sample_aligned", async () => {
  const pcmAudio = new Uint8Array(4 * 1024);
  for (let i = 0; i < pcmAudio.length; i++) pcmAudio[i] = i % 4;

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/speak") {
        return new Response("not found", { status: 404 });
      }
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(pcmAudio.slice(0, 2047));
          await sleep(0.01);
          controller.enqueue(pcmAudio.slice(2047));
          controller.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "audio/l16" } });
    },
  });

  let downFrames: Frame[];
  try {
    const ttsService = new DeepgramHttpTTSService({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}`,
      sampleRate: 24000,
    });

    // Metrics on: the TTFA scan reads the audio as 16-bit samples.
    [downFrames] = await runTest(ttsService, {
      framesToSend: [new TTSSpeakFrame({ text: "Hello from Deepgram." })],
      pipelineParams: new PipelineParams({ enableMetrics: true }),
    });
  } finally {
    server.stop(true);
  }

  const audioFrames = downFrames.filter(
    (frame): frame is TTSAudioRawFrame => frame instanceof TTSAudioRawFrame,
  );
  expect(audioFrames.length).toBeGreaterThan(0);
  expect(audioFrames.every((frame) => frame.audio.length % 2 === 0)).toBe(true);
  const joined = new Uint8Array(audioFrames.reduce((n, f) => n + f.audio.length, 0));
  let offset = 0;
  for (const frame of audioFrames) {
    joined.set(frame.audio, offset);
    offset += frame.audio.length;
  }
  expect(joined).toEqual(pcmAudio);
});
