// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/transports/websocket.mdx. Type-checked on every docs build.

// #region usage
import { createTask } from "@pipedog/asyncio";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import { honoWebsocket } from "@pipedog/transport-websocket/hono";
import { serveFetch, websocketServe } from "@pipedog/transport-websocket/serve";
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";

/** Runs one bot on an accepted WebSocket connection. */
async function runBot(connection: WebsocketConnection): Promise<void> {
  const transport = new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      serializer: new ProtobufFrameSerializer(),
      sessionTimeout: 300,
    }),
  );

  const pipeline = new Pipeline([
    transport.input(),
    // ... STT, LLM context aggregators, LLM, TTS
    transport.output(),
  ]);
  const worker = new PipelineWorker(pipeline);
  const runner = new WorkerRunner({ handleSigint: false });

  transport.eventHandler("on_client_connected", async () => {
    console.log("client connected");
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await runner.cancel();
  });

  await runner.addWorkers(worker);
  await runner.run();
}
// #endregion usage

// #region fetch
// Cloudflare Workers (and Durable Objects) and Deno upgrade the request from fetch.
const handler = websocketFetchHandler(runBot);

const workerEntry = {
  fetch(request: Request): Promise<Response> {
    return handler(request);
  },
};
// #endregion fetch

// #region serve-fetch
// Bun, Node (with the `ws` package) and Deno: serve the same fetch handler, with upgrades.
const fetchServer = await serveFetch(handler, { host: "0.0.0.0", port: 8765 });

// Later: stop listening.
await fetchServer.close();
// #endregion serve-fetch

// #region serve
// Bun, Node (with the `ws` package) and Deno: listen on a port.
const server = await websocketServe({
  handler: runBot,
  host: "0.0.0.0",
  port: 8765,
  origins: ["https://app.example.com"],
});

// Later: stop listening, close the open connections and wait for their handlers.
await server.close();
// #endregion serve

// #region hono
// Pass the result to Hono's upgradeWebSocket() (hono/bun, hono/deno,
// hono/cloudflare-workers or @hono/node-ws).
const honoEvents = (request: Request) => honoWebsocket(runBot, { headers: request.headers });
// #endregion hono

// #region bun
// Bun's ServerWebSocket reports its events to Bun.serve, so feed them to a
// WebsocketConnection built on a sink.
type SocketData = { connection: WebsocketConnection | null };

Bun.serve<SocketData>({
  port: 3000,
  fetch(request, bunServer) {
    if (bunServer.upgrade(request, { data: { connection: null } })) return undefined;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const connection = new WebsocketConnection({
        send: (message) => ws.send(message),
        close: (code, reason) => ws.close(code, reason),
      });
      ws.data.connection = connection;
      createTask(() => runBot(connection), "bun-socket");
    },
    message(ws, message) {
      ws.data.connection?.feedMessage(message);
    },
    close(ws, code, reason) {
      ws.data.connection?.feedClose(code, reason);
    },
  },
});
// #endregion bun
