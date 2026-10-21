// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { bunWebSocket, type UpgradingServer } from "@pipedog/transport-websocket/fetch";
import { offer, socket } from "./voice.ts";

const config = {
  fetch(request: Request, server: UpgradingServer) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/offer") return offer(request);
    // `socket` upgrades with the server Bun passes to `fetch`.
    if (pathname === "/ws") return socket(request, server);
    return new Response("not found", { status: 404 });
  },
  // Hands each upgraded socket's messages and close to its connection.
  websocket: bunWebSocket,
};

// `bun server.ts` serves the default export, on port 3000 or $PORT.
export default config;
