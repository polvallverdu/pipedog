// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// One voice session. The Durable Object accepts the WebSocket and runs the
// voice agent for as long as the socket is open, on its own event loop.
//
// A client that drops and reconnects to the same session within
// RESUME_WINDOW_MS continues the same conversation: the object keeps it in its
// storage between connections, and clears it once the window passes.

import { DurableObject } from "cloudflare:workers";
import type { LLMContextMessage } from "@pipedog/core/processors/aggregators/llm_context";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import { runVoiceAgent } from "./bot.ts";
import type { Env } from "./worker.ts";

/** How long a dropped session can be resumed. */
const RESUME_WINDOW_MS = 10 * 60 * 1000;
const HISTORY_KEY = "history";

export class VoiceSession extends DurableObject<Env> {
  readonly #handler = websocketFetchHandler((connection) => this.#run(connection));
  #active: { connection: WebsocketConnection; done: Promise<void> } | null = null;

  override fetch(request: Request): Promise<Response> {
    return this.#handler(request);
  }

  /** The conversation expired: forget it. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.delete(HISTORY_KEY);
  }

  async #run(connection: WebsocketConnection): Promise<void> {
    // A reconnect can arrive before the old socket is known to be gone. The new
    // connection wins; wait for the old one to save its conversation first.
    const previous = this.#active;
    if (previous) {
      await previous.connection.close();
      await previous.done;
    }

    const done = this.#serve(connection);
    this.#active = { connection, done };
    try {
      await done;
    } finally {
      if (this.#active?.connection === connection) this.#active = null;
    }
  }

  async #serve(connection: WebsocketConnection): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    // The messages are plain JSON objects here (text turns), so storage keeps them as they are.
    const history = (await this.ctx.storage.get<LLMContextMessage[]>(HISTORY_KEY)) ?? [];
    const messages = await runVoiceAgent(connection, this.env, history);
    await this.ctx.storage.put(HISTORY_KEY, messages);
    await this.ctx.storage.setAlarm(Date.now() + RESUME_WINDOW_MS);
  }
}
