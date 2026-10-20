// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. Every transport runs a real pipeline
// over a real socket, with the protobuf serializer:
//
// - Bun, Node, Deno: SingleClientWebsocketServerTransport on the runtime's
//   server (`ws` on Node), FastAPIWebsocketTransport behind `websocketServe()`,
//   WebsocketClientTransport and RTVIClientTransport over the global WebSocket.
// - workerd (can't listen on a port): `websocketServe()` refuses with its
//   documented error; FastAPIWebsocketTransport, WebsocketClientTransport and
//   RTVIClientTransport run over the two ends of a WebSocketPair.

import { waitFor } from "@pipedog/asyncio";
import { EndFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { WorkerRunner } from "@pipedog/core/workers/runner";

import { WebsocketClientParams } from "../src/client.ts";
import { honoWebsocket } from "../src/hono.ts";
import { RTVIClientTransport } from "../src/rtvi_client.ts";
import { websocketServe } from "../src/serve.ts";
import {
  type WebSocketLike,
  type WebsocketConnectFn,
  WebsocketConnection,
  websocketConnect,
} from "../src/socket.ts";
import { quietLogs, runEchoBotOnSocket, runEchoClient, runEchoServer } from "../test/e2e/apps.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`transport-websocket smoke: ${message}`);
}

const isWorkerd =
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ===
  "Cloudflare-Workers";

/** A port that is probably free: the smoke can't ask the server which one it got. */
function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

/** The two ends of a WebSocketPair, as connections. */
function pair(): [WebsocketConnection, WebsocketConnection] {
  const Pair = (
    globalThis as unknown as {
      WebSocketPair: new () => Record<0 | 1, WebSocketLike & { accept(): void }>;
    }
  ).WebSocketPair;
  const p = new Pair();
  p[0].accept();
  p[1].accept();
  return [WebsocketConnection.fromWebSocket(p[0]), WebsocketConnection.fromWebSocket(p[1])];
}

/** A minimal RTVI bot: answers `client-ready` with `bot-ready`. */
async function rtviBot(websocket: WebsocketConnection): Promise<void> {
  for await (const message of websocket) {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    const data = JSON.parse(text);
    if (data.label === "rtvi-ai" && data.type === "client-ready") {
      await websocket.send(
        JSON.stringify({
          label: "rtvi-ai",
          type: "bot-ready",
          id: data.id,
          data: { version: "1.2.0", about: {} },
        }),
      );
    }
  }
}

async function rtviHandshake(uri: string, connect: WebsocketConnectFn | null): Promise<boolean> {
  const transport = new RTVIClientTransport(uri, new WebsocketClientParams());
  if (connect) {
    (transport as unknown as { _session: { _connect: WebsocketConnectFn } })._session._connect =
      connect;
  }
  const worker = new PipelineWorker(new Pipeline([transport.input(), transport.output()]), {
    params: new PipelineParams(),
    cancelOnIdleTimeout: false,
  });
  transport.eventHandler("on_bot_ready", async () => {
    await worker.queueFrame(new EndFrame());
  });
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(worker);
  await waitFor(() => runner.run(), 10);
  return transport.botReady;
}

async function listen(handler: (ws: WebsocketConnection) => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    const port = randomPort();
    try {
      const server = await websocketServe({ handler, host: "127.0.0.1", port, origins: null });
      return { server, uri: `ws://127.0.0.1:${port}` };
    } catch (e) {
      if (attempt >= 5) throw e;
    }
  }
}

async function onWorkerd(): Promise<void> {
  let refused = false;
  try {
    await websocketServe({ handler: async () => {}, host: "127.0.0.1", port: 1 });
  } catch (e) {
    refused = e instanceof Error && e.message.includes("WebSocketPair");
  }
  check(refused, "websocketServe() should refuse on workerd and point to WebSocketPair");

  // FastAPIWebsocketTransport <- WebsocketClientTransport, over a WebSocketPair.
  const [serverEnd, clientEnd] = pair();
  const bot = runEchoBotOnSocket(serverEnd);
  const result = await runEchoClient("ws://pair", 10, null, async () => clientEnd);
  check(result.ok, `echo over a WebSocketPair failed: ${JSON.stringify(result)}`);
  await waitFor(() => bot, 10);

  // RTVIClientTransport handshake, over a WebSocketPair.
  const [rtviServer, rtviClient] = pair();
  const rtvi = rtviBot(rtviServer);
  check(await rtviHandshake("ws://pair", async () => rtviClient), "RTVI handshake failed");
  await rtvi;
}

async function onServerRuntime(): Promise<void> {
  // SingleClientWebsocketServerTransport <- WebsocketClientTransport.
  {
    const port = randomPort();
    let ready!: () => void;
    const listening = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const server = runEchoServer(port, () => ready());
    await waitFor(() => listening, 10);
    const result = await runEchoClient(`ws://127.0.0.1:${port}`);
    check(result.ok, `server transport echo failed: ${JSON.stringify(result)}`);
    // The bot ends its pipeline once its client is gone.
    await waitFor(() => server, 10);
  }

  // FastAPIWebsocketTransport behind websocketServe() <- WebsocketClientTransport.
  {
    const { server, uri } = await listen(runEchoBotOnSocket);
    const result = await runEchoClient(uri);
    check(result.ok, `FastAPI transport echo failed: ${JSON.stringify(result)}`);
    await server.close();
  }

  // RTVIClientTransport handshake.
  {
    const { server, uri } = await listen(rtviBot);
    check(await rtviHandshake(uri, null), "RTVI handshake failed");
    await server.close();
  }

  // A bare client connection round trip.
  {
    const { server, uri } = await listen(async (ws) => {
      for await (const m of ws) await ws.send(m);
    });
    const ws = await websocketConnect(uri);
    await ws.send(new Uint8Array([1, 2, 3]));
    const echoed = await ws.recv();
    check(echoed instanceof Uint8Array && echoed.join() === "1,2,3", "binary echo failed");
    await ws.send("text ✓");
    check((await ws.recv()) === "text ✓", "text echo failed");
    await ws.close();
    await server.close();
  }
}

export default async function smoke(): Promise<void> {
  quietLogs();
  // The Hono adapter needs nothing from Hono at runtime.
  const events = honoWebsocket(async () => {});
  check(typeof events.onOpen === "function", "honoWebsocket() events");

  if (isWorkerd) {
    await onWorkerd();
  } else {
    await onServerRuntime();
  }
}
