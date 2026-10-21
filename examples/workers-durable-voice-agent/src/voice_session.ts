// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// One voice session. The Durable Object accepts the WebSocket and runs the
// voice agent for as long as the socket is open, on its own event loop.

import { DurableObject } from "cloudflare:workers";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import { runVoiceAgent } from "./bot.ts";
import type { Env } from "./worker.ts";

export class VoiceSession extends DurableObject<Env> {
  readonly #handler = websocketFetchHandler((connection) => runVoiceAgent(connection, this.env));

  override fetch(request: Request): Promise<Response> {
    return this.#handler(request);
  }
}
