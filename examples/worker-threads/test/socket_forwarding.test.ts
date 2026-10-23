// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import { type FetchServer, serveFetch } from "@pipedog/transport-websocket/serve";
import { forwardConnection } from "../src/socket_forwarding.ts";
import { spawnThread, type ThreadPort } from "../src/threads.ts";

let worker: ThreadPort;
let server: FetchServer;

beforeAll(async () => {
  worker = await spawnThread(new URL("./fixtures/echo_bot_thread.ts", import.meta.url));
  const handler = websocketFetchHandler((connection) =>
    forwardConnection(connection, worker, { path: connection.path }),
  );
  server = await serveFetch((request, upgrading) => handler(request, upgrading), { port: 0 });
});

afterAll(async () => {
  await server.close();
  await worker.terminate();
});

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${server.port}/call`);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("connect failed"));
  });
}

const next = (ws: WebSocket) =>
  new Promise<string | ArrayBuffer>((resolve) => {
    ws.onmessage = (e) => resolve(e.data);
  });

describe("forwardConnection / acceptConnections", () => {
  test("text and binary messages reach the worker's bot and come back", async () => {
    const ws = await connect();
    let reply = next(ws);
    ws.send("hello");
    expect(await reply).toBe("echo hello /call");
    reply = next(ws);
    ws.send(new Uint8Array([1, 2, 3]));
    expect(Array.from(new Uint8Array((await reply) as ArrayBuffer))).toEqual([1, 2, 3]);
    ws.close();
  });

  test("several connections share one worker", async () => {
    const sockets = await Promise.all([connect(), connect(), connect()]);
    const replies = sockets.map((ws, i) => {
      const r = next(ws);
      ws.send(`n${i}`);
      return r;
    });
    expect(await Promise.all(replies)).toEqual(["echo n0 /call", "echo n1 /call", "echo n2 /call"]);
    for (const ws of sockets) ws.close();
  });

  test("the bot closing its connection closes the client's socket", async () => {
    const ws = await connect();
    const closed = new Promise<number>((resolve) => {
      ws.onclose = (e) => resolve(e.code);
    });
    ws.send("bye");
    expect(await closed).toBe(1000);
  });
});
