// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_stt_reconnect.py

/**
 * Reconnect behavior of websocket STT services against a local fake provider.
 *
 * Each service runs in a test pipeline fed with real-time 20 ms audio frames. The
 * fake provider answers every few audio messages with a final transcript naming
 * the connection that received them, so a transcript reaches downstream only when
 * the socket receiving audio is the socket the receive loop reads.
 */

import { describe, expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import { type Frame, InputAudioRawFrame, TranscriptionFrame } from "@pipedog/core/frames/frames";
import type { WebsocketConnectOptions } from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import type { ServerWebSocket } from "bun";

import { ElevenLabsRealtimeSTTService } from "../../elevenlabs/src/stt.ts";
import { SmallestSTTService } from "../../smallest/src/stt.ts";
import { CartesiaSTTService } from "../src/stt.ts";

const SERVICES = ["cartesia", "elevenlabs", "smallest"];

// Long enough that audio frames keep arriving while a handshake is in flight.
const HANDSHAKE_DELAY = 0.1;
const TRANSCRIPT_EVERY = 5;
const FRAME_SECONDS = 0.02;

class _Connection {
  id: number;
  audioMessages = 0;
  closed = false;

  constructor(id: number) {
    this.id = id;
  }
}

class _FakeProvider {
  service: string;
  dropFirstAfter: number | null;
  rejectFirstHandshake: boolean;
  connections: _Connection[] = [];
  handshakes = 0;

  constructor(
    service: string,
    options: { dropFirstAfter?: number | null; rejectFirstHandshake?: boolean } = {},
  ) {
    this.service = service;
    this.dropFirstAfter = options.dropFirstAfter ?? null;
    this.rejectFirstHandshake = options.rejectFirstHandshake ?? false;
  }

  /** Returns a rejection response, or null to accept the handshake. */
  async processRequest(): Promise<Response | null> {
    this.handshakes += 1;
    await sleep(HANDSHAKE_DELAY);
    if (this.rejectFirstHandshake && this.handshakes === 1) {
      return new Response("unavailable\n", { status: 503 });
    }
    return null;
  }

  _isAudio(message: string | Uint8Array): boolean {
    if (this.service === "elevenlabs") {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      return JSON.parse(text).message_type === "input_audio_chunk";
    }
    return typeof message !== "string";
  }

  _transcript(text: string): string {
    if (this.service === "cartesia") {
      return JSON.stringify({ type: "transcript", text, is_final: true });
    }
    if (this.service === "elevenlabs") {
      return JSON.stringify({ message_type: "committed_transcript", text });
    }
    return JSON.stringify({ transcript: text, is_final: true });
  }

  open(websocket: ServerWebSocket<{ conn?: _Connection }>): void {
    const conn = new _Connection(this.connections.length + 1);
    this.connections.push(conn);
    websocket.data.conn = conn;
    if (this.service === "elevenlabs") {
      websocket.send(JSON.stringify({ message_type: "session_started" }));
    }
  }

  message(websocket: ServerWebSocket<{ conn?: _Connection }>, message: string | Uint8Array): void {
    const conn = websocket.data.conn as _Connection;
    if (conn.closed || !this._isAudio(message)) {
      return;
    }
    conn.audioMessages += 1;
    if (conn.id === 1 && conn.audioMessages === this.dropFirstAfter) {
      conn.closed = true;
      websocket.terminate();
      return;
    }
    if (conn.audioMessages % TRANSCRIPT_EVERY === 0) {
      websocket.send(this._transcript(`c${conn.id}`));
    }
  }
}

function _makeService(name: string, port: number) {
  if (name === "cartesia") {
    return new CartesiaSTTService({ apiKey: "test-key", baseUrl: `ws://127.0.0.1:${port}` });
  }
  if (name === "smallest") {
    return new SmallestSTTService({ apiKey: "test-key", baseUrl: `ws://127.0.0.1:${port}` });
  }
  const service = new ElevenLabsRealtimeSTTService({
    apiKey: "test-key",
    baseUrl: `127.0.0.1:${port}`,
  });
  const websocketConnect = service._websocketConnect.bind(service);

  service._websocketConnect = async (uri: string, options?: WebsocketConnectOptions) =>
    await websocketConnect(uri.replace("wss://", "ws://"), options);
  return service;
}

async function _run(provider: _FakeProvider, seconds: number): Promise<string[]> {
  const server = Bun.serve<{ conn?: _Connection }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      const rejection = await provider.processRequest();
      if (rejection) {
        return rejection;
      }
      if (srv.upgrade(request, { data: {} })) {
        return undefined;
      }
      return new Response("upgrade failed\n", { status: 400 });
    },
    websocket: {
      open: (ws) => provider.open(ws),
      message: (ws, message) => provider.message(ws, message),
    },
  });
  try {
    const port = server.port as number;
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
    const [down] = await runTest(_makeService(provider.service, port), { framesToSend: frames });
    return down.filter((f) => f instanceof TranscriptionFrame).map((f) => f.text);
  } finally {
    server.stop(true);
  }
}

describe.each(SERVICES)("%s", (service) => {
  test("test_a_dropped_connection_is_replaced_by_one_new_connection", async () => {
    const provider = new _FakeProvider(service, { dropFirstAfter: 15 });

    const transcripts = await _run(provider, 1.5);

    expect(provider.connections.length).toBe(2);
    const second = provider.connections[1] as _Connection;
    expect(second.audioMessages).toBeGreaterThanOrEqual(TRANSCRIPT_EVERY);
    // Allow for a transcript still in flight when the pipeline ends.
    expect(transcripts.filter((t) => t === "c2").length).toBeGreaterThanOrEqual(
      Math.floor(second.audioMessages / TRANSCRIPT_EVERY) - 1,
    );
  });

  test("test_a_failed_first_connect_is_retried", async () => {
    const provider = new _FakeProvider(service, { rejectFirstHandshake: true });

    const transcripts = await _run(provider, 1.0);

    expect(provider.handshakes).toBe(2);
    expect(provider.connections.length).toBe(1);
    expect(transcripts).toContain("c1");
  });
});
