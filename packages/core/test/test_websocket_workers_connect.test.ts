// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// On Cloudflare Workers, websocketConnect opens the socket with fetch() and an
// Upgrade header, so the headers services authenticate with are sent.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { websocketConnect } from "../src/services/websocket_service.ts";

class FakeSocket extends EventTarget {
  readyState = 1;
  accepted = false;
  sent: unknown[] = [];
  accept() {
    this.accepted = true;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

const g = globalThis as any;
let savedFetch: typeof fetch;
let savedPair: unknown;
let calls: { url: string; headers: Record<string, string> }[];
let socket: FakeSocket;

beforeEach(() => {
  savedFetch = g.fetch;
  savedPair = g.WebSocketPair;
  g.WebSocketPair = function WebSocketPair() {};
  calls = [];
  socket = new FakeSocket();
  g.fetch = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return { status: 101, webSocket: socket };
  };
});

afterEach(() => {
  g.fetch = savedFetch;
  g.WebSocketPair = savedPair;
});

test("connects with fetch, sending headers and subprotocols", async () => {
  const connection = await websocketConnect(
    "wss://api.example.com/v1/realtime?intent=transcription",
    {
      additionalHeaders: { Authorization: "Bearer key" },
      subprotocols: ["realtime", "v1"],
    },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.example.com/v1/realtime?intent=transcription");
  expect(calls[0]!.headers.Authorization).toBe("Bearer key");
  expect(calls[0]!.headers.Upgrade).toBe("websocket");
  expect(calls[0]!.headers["Sec-WebSocket-Protocol"]).toBe("realtime, v1");
  expect(socket.accepted).toBe(true);
  await connection.send("hello");
  expect(socket.sent).toEqual(["hello"]);
});

test("a response without a socket fails the connect", async () => {
  g.fetch = async () => ({ status: 401 });
  await expect(websocketConnect("ws://localhost/x")).rejects.toThrow("HTTP 401");
});

/** undici's rejection of an Upgrade header, as fetch throws it on OpenOrange. */
function undiciUpgradeRejection(): TypeError {
  const cause = Object.assign(new Error("invalid upgrade header"), {
    name: "InvalidArgumentError",
    code: "UND_ERR_INVALID_ARG",
  });
  return new TypeError("fetch failed", { cause });
}

test("falls back to the WebSocket constructor where fetch can't upgrade", async () => {
  g.fetch = async () => {
    throw undiciUpgradeRejection();
  };
  const constructed: { url: string; init: unknown }[] = [];
  const savedWebSocket = g.WebSocket;
  class ConstructedSocket extends FakeSocket {
    static OPEN = 1;
    constructor(url: string, init: unknown) {
      super();
      constructed.push({ url, init });
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }, 0);
    }
  }
  g.WebSocket = ConstructedSocket;
  try {
    const connection = await websocketConnect("wss://api.example.com/ws", {
      additionalHeaders: { Authorization: "Bearer key" },
    });
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.url).toBe("wss://api.example.com/ws");
    expect(constructed[0]!.init).toMatchObject({ headers: { Authorization: "Bearer key" } });
    await connection.send("hello");
  } finally {
    g.WebSocket = savedWebSocket;
  }
});

test("any other fetch error fails the connect", async () => {
  g.fetch = async () => {
    throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
  };
  await expect(websocketConnect("wss://example.com/ws")).rejects.toThrow("fetch failed");
});
