// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// HTTP server for the voice bot: serves the page and the SmallWebRTC offer
// endpoint, and starts a conversation for every connection.
//
//   bun src/server.ts        (env: OPENAI_API_KEY, PORT=7860)

import { readFileSync } from "node:fs";
import http from "node:http";
import { createTask } from "@pipedog/asyncio";
import { nodeRequestListener, smallWebRTCOfferHandler } from "@pipedog/transport-smallwebrtc/http";
import { SmallWebRTCRequestHandler } from "@pipedog/transport-smallwebrtc/request_handler";
import { runVoiceBot, type VoiceBotOptions } from "./bot.ts";

const page = readFileSync(new URL("../public/index.html", import.meta.url));

/** The HTTP server; `listen` it on a port of your choice. */
export function createServer(options: VoiceBotOptions = {}): http.Server {
  const offer = smallWebRTCOfferHandler(new SmallWebRTCRequestHandler(), (connection) => {
    createTask(() => runVoiceBot(connection, options), "voice-bot");
  });

  async function app(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/api/offer") return offer(request);
    return new Response("not found", { status: 404 });
  }

  return http.createServer(nodeRequestListener(app));
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 7860);
  createServer().listen(port, () => {
    console.log(`Voice bot: open http://localhost:${port}`);
  });
}
