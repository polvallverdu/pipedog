// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// HTTP server for the voice bot: serves the page and the WebSocket endpoint, and
// starts a conversation for every connection. Runs on Bun and on Node; the
// WebSocket upgrade is handled by the `ws` package.
//
//   bun src/server.ts        (env: VOICE_PROVIDER=openai|google, OPENAI_API_KEY or
//                             GOOGLE_API_KEY, PORT=7860)

import { readFileSync } from "node:fs";
import http from "node:http";
import { createTask, rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import { WebSocketServer } from "ws";
import { runVoiceBot, type VoiceBotOptions, type VoiceProvider } from "./bot.ts";

const page = readFileSync(new URL("../public/index.html", import.meta.url));

/** The HTTP server; `listen` it on a port of your choice. */
export function createServer(options: VoiceBotOptions = {}): http.Server {
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      return;
    }
    response.writeHead(404).end("not found");
  });

  // `/ws` takes the WebSocket connections; each one gets its own conversation.
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const connection = WebsocketConnection.fromWebSocket(ws, { headers, path: "/ws" });
      createTask(async () => {
        try {
          await runVoiceBot(connection, options);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.error("voice bot failed", e);
        } finally {
          await connection.close();
        }
      }, "voice-bot");
    });
  });
  server.on("close", () => sockets.close());

  return server;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 7860);
  const provider = (process.env.VOICE_PROVIDER ?? "openai") as VoiceProvider;
  if (provider !== "openai" && provider !== "google") {
    throw new Error(`VOICE_PROVIDER must be "openai" or "google", not "${provider}"`);
  }
  createServer({ provider }).listen(port, () => {
    console.log(`Voice bot (${provider}): open http://localhost:${port}`);
  });
}
