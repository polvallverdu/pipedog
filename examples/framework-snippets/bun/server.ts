// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { createTask } from "@pipedog/asyncio";
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import { offer, runSocketAgent } from "./voice.ts";

type SocketData = { connection: WebsocketConnection | null };

const config = {
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
      createTask(() => runSocketAgent(connection), "bun-socket");
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

// `bun server.ts` starts it on port 3000.
if (import.meta.main) {
  Bun.serve({ port: 3000, ...config });
}
