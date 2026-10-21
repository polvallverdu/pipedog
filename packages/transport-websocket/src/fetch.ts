// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// WebSocket endpoints as fetch handlers, `(Request) => Promise<Response>`, for
// runtimes that upgrade a request from fetch: Cloudflare Workers and Durable
// Objects (`WebSocketPair`), and Deno (`Deno.upgradeWebSocket`). The handler
// returns the 101 response; the connection goes to `onConnection`. Hono, Next.js,
// SvelteKit and oRPC route to the same handler. Bun and Node upgrade on their
// own server instead (see serve.ts and hono.ts).

import { createTask, rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { type WebSocketLike, WebsocketConnection } from "./socket.ts";

/** The response that completes a WebSocket upgrade, and the server side of the socket. */
export interface UpgradedWebSocket {
  response: Response;
  socket: WebSocketLike;
}

/**
 * Upgrade `request` to a WebSocket, from fetch.
 *
 * @throws Error on a runtime that can't upgrade from fetch (Bun and Node upgrade
 *   on their server; see `websocketServe`).
 */
export function upgradeWebSocket(request: Request): UpgradedWebSocket {
  const g = globalThis as any;
  if (typeof g.WebSocketPair === "function") {
    const pair = new g.WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // `webSocket` is a Workers extension to ResponseInit, missing from the DOM types.
    const init = { status: 101, webSocket: client } as ResponseInit;
    return { response: new Response(null, init), socket: server };
  }
  if (typeof g.Deno?.upgradeWebSocket === "function") {
    return g.Deno.upgradeWebSocket(request);
  }
  throw new Error(
    "This runtime can't upgrade a Request to a WebSocket from fetch. On Bun and Node, " +
      "serve the WebSocket on the runtime's server instead.",
  );
}

/**
 * A fetch handler for a WebSocket endpoint. Each upgraded connection is handed
 * to `onConnection` as a `WebsocketConnection`, which runs in its own task; the
 * connection closes when the task ends.
 *
 * @example
 * // A Durable Object (or any Worker) serving one voice session per connection.
 * export class VoiceSession extends DurableObject {
 *   #handler = websocketFetchHandler(async (connection) => {
 *     await runVoiceBot(connection);
 *   });
 *
 *   fetch(request: Request) {
 *     return this.#handler(request);
 *   }
 * }
 */
export function websocketFetchHandler(
  onConnection: (connection: WebsocketConnection) => void | Promise<void>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("This endpoint takes WebSocket connections.", {
        status: 426,
        headers: { upgrade: "websocket" },
      });
    }
    // Copy what the connection needs now: some runtimes close the request once
    // it is upgraded, and reading it afterwards throws.
    const headers = new Headers(request.headers);
    const path = new URL(request.url).pathname;
    const { response, socket } = upgradeWebSocket(request);
    const connection = WebsocketConnection.fromWebSocket(socket, { headers, path });
    createTask(async () => {
      try {
        await onConnection(connection);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error("WebSocket handler failed", e);
      } finally {
        await connection.close();
      }
    }, `websocket-fetch::${connection}`);
    return response;
  };
}
