// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_stt_send_retry_first_connect.py

/**
 * Failed first connects in Cartesia Turns STT, which reconnects from `sendWithRetry`.
 *
 * Cartesia Turns waits for the server's "connected" message before a socket
 * counts as ready, so it reconnects on demand when sending audio rather than from
 * the receive loop. A local fake provider rejects handshakes and then sends that
 * message on the connections it accepts.
 */

import { afterEach, expect, test } from "bun:test";
import { sleep, waitFor } from "@pipedog/asyncio";
import { type Frame, InputAudioRawFrame } from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";

import { CartesiaTurnsSTTService } from "../src/turns/stt.ts";

const FRAME_SECONDS = 0.02;
const MAX_RETRIES = 3;

function _makeService(port: number): CartesiaTurnsSTTService {
  const service = new CartesiaTurnsSTTService({
    apiKey: "test-key",
    url: `ws://127.0.0.1:${port}`,
  });
  // Keep the retry backoff short so a provider that never comes back is
  // given up on within the test.
  service._reconnectBackoffMinWait = 0.01;
  service._reconnectBackoffMaxWait = 0.01;
  return service;
}

async function _run(
  rejectedHandshakes: number,
  seconds: number,
  confirm = true,
): Promise<[CartesiaTurnsSTTService, number, number]> {
  let handshakes = 0;
  let audioMessages = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      handshakes += 1;
      if (handshakes <= rejectedHandshakes) {
        return new Response("unavailable\n", { status: 503 });
      }
      if (srv.upgrade(request, { data: undefined })) {
        return undefined;
      }
      return new Response("upgrade failed\n", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (confirm) {
          const connected = { type: "connected", request_id: "test-request" };
          ws.send(JSON.stringify(connected));
        }
      },
      message(_ws, message) {
        if (typeof message !== "string") {
          audioMessages += 1;
        }
      },
    },
  });
  try {
    const service = _makeService(server.port as number);
    const frames: Frame[] = [];
    for (let i = 0; i < Math.trunc(seconds / FRAME_SECONDS); i++) {
      frames.push(
        new InputAudioRawFrame({
          audio: new Uint8Array(2 * 320),
          sampleRate: 16000,
          numChannels: 1,
        }),
      );
      frames.push(new SleepFrame({ sleep: FRAME_SECONDS }));
    }
    await runTest(service, { framesToSend: frames });
    // Let any connection still being served record what it received.
    await sleep(0.05);
    return [service, handshakes, audioMessages];
  } finally {
    server.stop(true);
  }
}

// monkeypatch.setattr(CartesiaTurnsSTTService, "_CONNECTION_TIMEOUT", ...) is undone after each test.
const _originalConnectionTimeout = CartesiaTurnsSTTService._CONNECTION_TIMEOUT;
afterEach(() => {
  CartesiaTurnsSTTService._CONNECTION_TIMEOUT = _originalConnectionTimeout;
});

test("test_a_failed_first_connect_is_retried_when_audio_arrives", async () => {
  const [, handshakes, audioMessages] = await _run(1, 0.5);

  expect(handshakes).toBe(2);
  expect(audioMessages).toBeGreaterThan(0);
});

test("test_a_provider_that_never_accepts_leaves_the_service_unusable", async () => {
  const [stt, handshakes, audioMessages] = await _run(100, 0.5);

  // The setup connect, then one round of retries; once the service is
  // unusable it takes no more audio, so it never tries again.
  expect(handshakes).toBe(1 + MAX_RETRIES);
  expect(audioMessages).toBe(0);
  expect(stt.isUsable).toBe(false);
});

// pytest has no per-test timeout; each attempt spends up to 2 s draining the
// unconfirmed socket, so lift bun's 5 s default above the test's own 10 s bound.
test("test_a_connection_that_is_never_confirmed_is_given_up_on", async () => {
  // The handshake succeeds but the server never sends `connected`, so each
  // attempt times out instead of holding the audio path forever.
  CartesiaTurnsSTTService._CONNECTION_TIMEOUT = 0.1;

  const [stt, handshakes, audioMessages] = await waitFor(() => _run(0, 0.5, false), 10);

  expect(handshakes).toBe(1 + MAX_RETRIES);
  expect(audioMessages).toBe(0);
  expect(stt.isUsable).toBe(false);
}, 15_000);
