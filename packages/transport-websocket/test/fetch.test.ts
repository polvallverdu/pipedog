// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { upgradeWebSocket, websocketFetchHandler } from "../src/fetch.ts";
import { WebsocketConnection } from "../src/socket.ts";

/** A stand-in for Workers' WebSocketPair: an EventTarget with accept/send/close. */
class FakeSocket extends EventTarget {
  readyState = 1;
  binaryType = "blob";
  accepted = false;
  sent: unknown[] = [];
  accept() {
    this.accepted = true;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

class FakeWebSocketPair {
  0 = new FakeSocket();
  1 = new FakeSocket();
  constructor() {
    globals.lastPair = this;
  }
}

const globals = globalThis as any;
let saved: unknown;

beforeEach(() => {
  saved = globals.WebSocketPair;
  globals.WebSocketPair = FakeWebSocketPair;
});

afterEach(() => {
  globals.WebSocketPair = saved;
});

describe("upgradeWebSocket", () => {
  test("accepts the server side and returns the client side in a 101 response", () => {
    const { response, socket } = upgradeWebSocket(new Request("http://x/ws"));
    const pair = globals.lastPair as FakeWebSocketPair;
    expect(response.status).toBe(101);
    expect(socket).toBe(pair[1]);
    expect(pair[1].accepted).toBe(true);
    expect(pair[0].accepted).toBe(false);
  });

  test("throws on a runtime that can't upgrade from fetch", () => {
    globals.WebSocketPair = undefined;
    expect(() => upgradeWebSocket(new Request("http://x/ws"))).toThrow(
      "can't upgrade a Request to a WebSocket from fetch",
    );
  });
});

describe("websocketFetchHandler", () => {
  test("hands each connection to onConnection, with the request's headers and path", async () => {
    let seen: WebsocketConnection | null = null;
    const handler = websocketFetchHandler(async (connection) => {
      seen = connection;
    });
    const response = await handler(
      new Request("http://x/api/session/abc", {
        headers: { upgrade: "websocket", "x-session": "abc" },
      }),
    );
    expect(response.status).toBe(101);

    // The task runs in the background; wait for it.
    for (let i = 0; i < 50 && seen === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const connection = seen as WebsocketConnection | null;
    expect(connection).toBeInstanceOf(WebsocketConnection);
    expect(connection?.headers.get("x-session")).toBe("abc");
    expect(connection?.path).toBe("/api/session/abc");
  });

  test("answers a request that isn't an upgrade with 426, and starts nothing", async () => {
    let started = false;
    const handler = websocketFetchHandler(async () => {
      started = true;
    });
    const response = await handler(new Request("http://x/ws"));
    expect(response.status).toBe(426);
    expect(response.headers.get("upgrade")).toBe("websocket");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(false);
  });

  test("closes the connection when onConnection finishes", async () => {
    let closed = false;
    const handler = websocketFetchHandler(async () => {});
    await handler(new Request("http://x/ws", { headers: { upgrade: "websocket" } }));
    const socket = (globals.lastPair as FakeWebSocketPair)[1];
    socket.addEventListener("close", () => {
      closed = true;
    });
    for (let i = 0; i < 50 && !closed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(closed).toBe(true);
  });
});
