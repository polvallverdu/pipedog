// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { honoWebsocket } from "@pipedog/transport-websocket/hono";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { offer, runSocketAgent } from "./voice.ts";

const app = new Hono();

app.post("/api/offer", (c) => offer(c.req.raw));
app.get(
  "/ws",
  upgradeWebSocket(() => honoWebsocket(runSocketAgent)),
);

// Bun serves the app; on Node, use @hono/node-server with the same routes.
export default { fetch: app.fetch, websocket };
