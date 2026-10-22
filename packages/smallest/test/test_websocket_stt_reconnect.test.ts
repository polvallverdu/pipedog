// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_stt_reconnect.py

/**
 * Reconnect behavior of SmallestSTTService against a local fake provider.
 *
 * Upstream parametrizes this file over Cartesia, ElevenLabs and Smallest; this
 * port holds the Smallest case, and the other providers' packages port theirs.
 *
 * The service runs in a test pipeline fed with real-time 20 ms audio frames.
 * The fake provider answers every few audio messages with a final transcript
 * naming the connection that received them, so a transcript reaches downstream
 * only when the socket receiving audio is the socket the receive loop reads.
 *
 * Porting notes:
 * - `websockets.serve(process_request=...)` → `Bun.serve`'s `fetch`, which
 *   sleeps before upgrading, or answers 503 for the first handshake.
 * - `websocket.transport.abort()` → `ws.terminate()` (an abrupt close).
 */

import { expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import { InputAudioRawFrame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { SmallestSTTService } from "../src/stt.ts";

// Long enough that audio frames keep arriving while a handshake is in flight.
const HANDSHAKE_DELAY = 0.1;
const TRANSCRIPT_EVERY = 5;
const FRAME_SECONDS = 0.02;

interface Connection {
  id: number;
  audioMessages: number;
}

interface FakeProviderOptions {
  dropFirstAfter?: number | null;
  rejectFirstHandshake?: boolean;
}

class FakeProvider {
  connections: Connection[] = [];
  handshakes = 0;
  readonly dropFirstAfter: number | null;
  readonly rejectFirstHandshake: boolean;

  constructor(options: FakeProviderOptions = {}) {
    this.dropFirstAfter = options.dropFirstAfter ?? null;
    this.rejectFirstHandshake = options.rejectFirstHandshake ?? false;
  }

  serve(): ReturnType<typeof Bun.serve> {
    const states = new WeakMap<object, Connection>();
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, srv) => {
        this.handshakes += 1;
        const handshake = this.handshakes;
        await sleep(HANDSHAKE_DELAY);
        if (this.rejectFirstHandshake && handshake === 1) {
          return new Response("unavailable\n", { status: 503 });
        }
        if (srv.upgrade(request, { data: undefined })) {
          return undefined;
        }
        return new Response("upgrade failed\n", { status: 400 });
      },
      websocket: {
        open: (ws) => {
          const conn: Connection = { id: this.connections.length + 1, audioMessages: 0 };
          this.connections.push(conn);
          states.set(ws, conn);
        },
        message: (ws, message) => {
          const conn = states.get(ws)!;
          // Smallest sends audio as binary messages.
          if (typeof message === "string") return;
          conn.audioMessages += 1;
          if (conn.id === 1 && conn.audioMessages === this.dropFirstAfter) {
            ws.terminate();
            return;
          }
          if (conn.audioMessages % TRANSCRIPT_EVERY === 0) {
            ws.send(JSON.stringify({ transcript: `c${conn.id}`, is_final: true }));
          }
        },
      },
    });
  }
}

async function run(provider: FakeProvider, seconds: number): Promise<string[]> {
  const server = provider.serve();
  try {
    const frames: (InputAudioRawFrame | SleepFrame)[] = [];
    for (let i = 0; i < Math.floor(seconds / FRAME_SECONDS); i++) {
      frames.push(
        new InputAudioRawFrame({
          audio: new Uint8Array(640),
          sampleRate: 16000,
          numChannels: 1,
        }),
      );
      frames.push(new SleepFrame({ sleep: FRAME_SECONDS }));
    }
    const service = new SmallestSTTService({
      apiKey: "test-key",
      baseUrl: `ws://127.0.0.1:${server.port}`,
    });
    const [down] = await runTest(service, { framesToSend: frames });
    return down.filter((f) => f instanceof TranscriptionFrame).map((f) => f.text);
  } finally {
    server.stop(true);
  }
}

test("test_a_dropped_connection_is_replaced_by_one_new_connection[smallest]", async () => {
  const provider = new FakeProvider({ dropFirstAfter: 15 });

  const transcripts = await run(provider, 1.5);

  expect(provider.connections.length).toBe(2);
  const second = provider.connections[1]!;
  expect(second.audioMessages).toBeGreaterThanOrEqual(TRANSCRIPT_EVERY);
  // Allow for a transcript still in flight when the pipeline ends.
  expect(transcripts.filter((t) => t === "c2").length).toBeGreaterThanOrEqual(
    Math.floor(second.audioMessages / TRANSCRIPT_EVERY) - 1,
  );
});

test("test_a_failed_first_connect_is_retried[smallest]", async () => {
  const provider = new FakeProvider({ rejectFirstHandshake: true });

  const transcripts = await run(provider, 1.0);

  expect(provider.handshakes).toBe(2);
  expect(provider.connections.length).toBe(1);
  expect(transcripts).toContain("c1");
});
