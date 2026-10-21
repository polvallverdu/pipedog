// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { bunWebSocket, type UpgradingServer } from "@pipedog/transport-websocket/fetch";
import { offer, socket } from "./voice.ts";

// Vercel Functions run this server with the Bun runtime (`"bunVersion": "1.x"` in
// vercel.json). Each WebSocket is pinned to one function instance for its lifetime,
// and messages don't cross instances: keep shared state in a database.
const config = {
  routes: {
    "/": new Response("voice agent", { headers: { "content-type": "text/plain" } }),
  },
  fetch(request: Request, server: UpgradingServer) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/offer") return offer(request);
    // `socket` upgrades with the server Bun passes to `fetch`.
    if (pathname === "/ws") return socket(request, server);
    return new Response("not found", { status: 404 });
  },
  websocket: bunWebSocket,
};

export default config;
