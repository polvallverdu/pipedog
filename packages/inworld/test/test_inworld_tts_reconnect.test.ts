// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_inworld_tts_reconnect.py

/**
 * Connection handling of Inworld WebSocket TTS against a local fake Inworld server.
 *
 * Each test speaks a few `TTSSpeakFrame` turns. The fake server can drop a
 * connection after a turn and delay handshakes, and a send can be made to stall
 * the way one does once the peer stops reading, which `wsSendTimeout` turns
 * into a dropped connection.
 *
 * Porting notes: the fake server is `Bun.serve` instead of `websockets.serve`;
 * `websocket.transport.abort()` is `ws.terminate()`. A stalled send is emulated
 * the way `WebsocketClientConnection` detects one: the socket stops writing and
 * reports a full write buffer, so the connection's own `sendTimeout` drops it.
 */

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  ErrorFrame,
  type Frame,
  TTSAudioRawFrame,
  TTSSpeakFrame,
} from "@pipedog/core/frames/frames";
import {
  ConnectionClosedError,
  WebsocketClientConnection,
  type WebsocketClientConnection as WebsocketClientConnectionType,
  type WebsocketData,
} from "@pipedog/core/services/websocket_service";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import type { ServerWebSocket } from "bun";

import { InworldTTSService } from "../src/tts.ts";

type Dict = Record<string, any>;

const TURNS = ["Hello there.", "How are you?", "Goodbye."];

interface SocketData {
  index: number;
  messages: Dict[];
  contexts: Set<string>;
  closed: number;
}

class _FakeInworld {
  // Abort the first connection once this many of its contexts have closed.
  dropAfterTurns: number | null;
  // Delay every handshake after the first.
  handshakeDelay: number;
  handshakes = 0;
  messagesPerConnection: Dict[][] = [];

  constructor(options: { dropAfterTurns?: number | null; handshakeDelay?: number } = {}) {
    this.dropAfterTurns = options.dropAfterTurns ?? null;
    this.handshakeDelay = options.handshakeDelay ?? 0.0;
  }

  async processRequest(): Promise<void> {
    this.handshakes += 1;
    if (this.handshakes > 1) {
      await new Promise((resolve) => setTimeout(resolve, this.handshakeDelay * 1000));
    }
  }

  newConnection(): SocketData {
    const index = this.messagesPerConnection.length;
    const messages: Dict[] = [];
    this.messagesPerConnection.push(messages);
    return { index, messages, contexts: new Set(), closed: 0 };
  }

  handle(websocket: ServerWebSocket<SocketData>, raw: string | Buffer): void {
    const data = websocket.data;
    const message = JSON.parse(String(raw)) as Dict;
    data.messages.push(message);
    const contextId = message.contextId ?? null;
    if ("create" in message) {
      data.contexts.add(contextId);
      _FakeInworld._send(websocket, contextId, { contextCreated: {} });
    } else if ("send_text" in message) {
      if (contextId === null) {
        _FakeInworld._sendStatus(websocket, null, 3, "context_id is required");
      } else if (!data.contexts.has(contextId)) {
        _FakeInworld._sendStatus(websocket, contextId, 5, "Context not found");
      } else if (message.send_text.text) {
        const audio = bytesToBase64(new Uint8Array(2 * 480));
        _FakeInworld._send(websocket, contextId, { audioChunk: { audioContent: audio } });
      }
    } else if ("flush_context" in message) {
      _FakeInworld._send(websocket, contextId, { flushCompleted: {} });
    } else if ("close_context" in message) {
      data.contexts.delete(contextId);
      _FakeInworld._send(websocket, contextId, { contextClosed: {} });
      data.closed += 1;
      if (data.index === 0 && data.closed === this.dropAfterTurns) {
        // Abort once the replies above are written, as asyncio's transport.abort()
        // does after its writes: Bun's terminate() can drop messages still queued,
        // and the turn's audio with them.
        setTimeout(() => websocket.terminate(), 50);
      }
    }
  }

  static _send(websocket: ServerWebSocket<SocketData>, contextId: string | null, result: Dict) {
    websocket.send(JSON.stringify({ result: { contextId, ...result } }));
  }

  static _sendStatus(
    websocket: ServerWebSocket<SocketData>,
    contextId: string | null,
    code: number,
    message: string,
  ) {
    _FakeInworld._send(websocket, contextId, { status: { code, message } });
  }

  textsSent(index: number): string[] {
    return (this.messagesPerConnection[index] ?? [])
      .filter((m) => "send_text" in m && m.send_text.text)
      .map((m) => String(m.send_text.text).trim());
  }
}

afterEach(() => {
  mock.restore();
});

/** Make matching sends wait as they do once the peer stops reading. */
function _stallSends(shouldStall: (message: Dict) => boolean): void {
  const send = WebsocketClientConnection.prototype.send;
  const stalled: WebsocketData[] = [];

  spyOn(WebsocketClientConnection.prototype, "send").mockImplementation(async function (
    this: WebsocketClientConnectionType,
    message: WebsocketData | ArrayBuffer,
  ): Promise<void> {
    if (typeof message === "string" && stalled.length === 0 && shouldStall(JSON.parse(message))) {
      stalled.push(message);
      // The peer has stopped reading: nothing more is written and the write
      // buffer stays full.
      const ws = this.webSocket;
      Object.defineProperty(ws, "send", { value: () => {}, configurable: true });
      Object.defineProperty(ws, "bufferedAmount", {
        get: () => 64 * 1024 * 1024,
        configurable: true,
      });
    }
    await send.call(this, message);
  });
}

function _sendsText(text: string): (m: Dict) => boolean {
  return (m) => String(m.send_text?.text ?? "").trim() === text;
}

function _fastFailures(service: InworldTTSService): void {
  service._wsSendTimeout = 0.1;
  service._reconnectBackoffMinWait = 0.05;
  service._reconnectBackoffMaxWait = 0.05;
}

async function _run(
  server: _FakeInworld,
  turns: string[],
  configure?: (service: InworldTTSService) => void,
): Promise<[InworldTTSService, Frame[], Frame[]]> {
  const s = Bun.serve<SocketData, never>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      await server.processRequest();
      if (srv.upgrade(request, { data: server.newConnection() })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        server.handle(ws, raw);
      },
    },
  });
  try {
    const service = new InworldTTSService({
      apiKey: "test-key",
      url: `ws://127.0.0.1:${s.port}`,
    });
    if (configure) {
      configure(service);
    }
    const frames: Frame[] = [];
    for (const text of turns) {
      frames.push(new TTSSpeakFrame({ text }), new SleepFrame({ sleep: 0.5 }));
    }
    const [down, up] = await runTest(service, { framesToSend: frames });
    return [service, down, up];
  } finally {
    s.stop(true);
  }
}

function _turnsWithAudio(down: Frame[]): number {
  return new Set(
    down.filter((f) => f instanceof TTSAudioRawFrame).map((f) => (f as TTSAudioRawFrame).contextId),
  ).size;
}

test("test_a_dropped_connection_is_replaced_before_the_next_turn", async () => {
  const server = new _FakeInworld({ dropAfterTurns: 1 });

  const [, down] = await _run(server, TURNS.slice(0, 2));

  expect(server.handshakes).toEqual(2);
  expect(server.textsSent(1)).toEqual([TURNS[1]!]);
  expect(_turnsWithAudio(down)).toEqual(2);
});

test("test_a_stalled_send_fails_its_turn_and_the_next_turn_is_spoken", async () => {
  _stallSends(_sendsText(TURNS[1]!));
  const server = new _FakeInworld();

  const [service, down, up] = await _run(server, TURNS, _fastFailures);

  expect(server.handshakes).toEqual(2);
  expect(server.textsSent(1)).toEqual([TURNS[2]!]);
  expect(_turnsWithAudio(down)).toEqual(2);
  expect(up.some((f) => f instanceof ErrorFrame)).toBe(true);
  expect(service.isUsable).toBe(true);
});

test("test_a_turn_starting_while_reconnecting_does_not_open_a_second_connection", async () => {
  // The second turn's context is created eagerly, as soon as the turn starts.
  const sentCreates: Dict[] = [];

  function secondCreate(message: Dict): boolean {
    if ("create" in message) {
      sentCreates.push(message);
    }
    return sentCreates.length === 2;
  }

  _stallSends(secondCreate);
  const server = new _FakeInworld({ handshakeDelay: 0.2 });

  const [, down, up] = await _run(server, TURNS, _fastFailures);

  expect(server.handshakes).toEqual(2);
  expect(server.textsSent(1)).toEqual([TURNS[2]!]);
  expect(_turnsWithAudio(down)).toEqual(2);
  expect(up.some((f) => f instanceof ErrorFrame && f.error.includes("reconnecting"))).toBe(true);
});

test("test_a_context_whose_create_failed_is_created_again", async () => {
  const service = new InworldTTSService({ apiKey: "test-key" });
  const results: (Error | null)[] = [new ConnectionClosedError(null, ""), null];
  const send = mock(async (_message: string) => {
    const result = results.shift();
    if (result) throw result;
  });
  service._websocket = { send } as unknown as WebsocketClientConnectionType;
  const s = service as unknown as { _sendContext(contextId: string): Promise<void> };

  await expect(s._sendContext("context")).rejects.toThrow(ConnectionClosedError);
  await s._sendContext("context");
  await s._sendContext("context");

  expect(send).toHaveBeenCalledTimes(2);
});
