// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { createTask } from "@pipedog/asyncio";
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import { offer, runSocketAgent } from "./voice.ts";

type SocketData = { connection: WebsocketConnection | null };

// Vercel Functions run this server with the Bun runtime (`"bunVersion": "1.x"` in
// vercel.json). Each WebSocket is pinned to one function instance for its lifetime,
// and messages don't cross instances: keep shared state in a database.
const config = {
  routes: {
    "/": new Response("voice agent", { headers: { "content-type": "text/plain" } }),
  },
  fetch(request: Request, server: Bun.Server<SocketData>) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/offer") return offer(request);
    if (pathname === "/ws" && server.upgrade(request, { data: { connection: null } })) {
      return undefined;
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws: Bun.ServerWebSocket<SocketData>) {
      const connection = new WebsocketConnection({
        send: (message) => ws.send(message),
        close: (code, reason) => ws.close(code, reason),
      });
      ws.data.connection = connection;
      createTask(() => runSocketAgent(connection), "vercel-socket");
    },
    message(ws: Bun.ServerWebSocket<SocketData>, message: string | Buffer) {
      ws.data.connection?.feedMessage(message);
    },
    close(ws: Bun.ServerWebSocket<SocketData>, code: number, reason: string) {
      ws.data.connection?.feedClose(code, reason);
    },
  },
};

export default config;
