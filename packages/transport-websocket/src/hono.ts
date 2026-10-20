// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Hono WebSocket handlers for the bring-your-own-socket transports.
 *
 * Hono's `upgradeWebSocket()` (from `hono/bun`, `hono/deno`,
 * `hono/cloudflare-workers` or `@hono/node-ws`) delivers a socket as event
 * callbacks. `honoWebsocket()` turns them into a `WebsocketConnection` and
 * runs your handler with it, typically a pipeline behind
 * `FastAPIWebsocketTransport`. It needs nothing from Hono at runtime, so it
 * works with any Hono adapter.
 *
 * @example
 * import { upgradeWebSocket, websocket } from "hono/bun";
 *
 * app.get(
 *   "/ws",
 *   upgradeWebSocket((c) =>
 *     honoWebsocket(async (ws) => runBot(ws), { headers: c.req.raw.headers }),
 *   ),
 * );
 * Bun.serve({ fetch: app.fetch, websocket });
 */

import { createTask, rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";

import { WebsocketConnection, type WebsocketConnectionOptions } from "./socket.ts";

/** The part of Hono's `WSContext` the handlers use. */
export interface HonoWSContextLike {
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

/** Hono's `WSEvents`, as `honoWebsocket()` returns them. */
export interface HonoWebsocketEvents {
  onOpen(evt: unknown, ws: HonoWSContextLike): void;
  onMessage(evt: { data: unknown }, ws: HonoWSContextLike): void;
  onClose(evt: { code?: number; reason?: string }, ws: HonoWSContextLike): void;
  onError(evt: unknown, ws: HonoWSContextLike): void;
}

/**
 * Build Hono WebSocket events that run `handler` with the connection.
 *
 * The handler runs in its own task once the socket opens; when it returns
 * (or fails), the connection is closed.
 *
 * @param handler Runs with the accepted connection.
 * @param options Connection details: pass the upgrade request's `headers`
 *   (`c.req.raw.headers`) so `allowedOrigins` can be checked.
 */
export function honoWebsocket(
  handler: (websocket: WebsocketConnection) => Promise<void>,
  options: Omit<WebsocketConnectionOptions, "state"> = {},
): HonoWebsocketEvents {
  // Copy the headers now, during the upgrade request: on Deno the request is
  // closed once upgraded, and reading its headers then throws.
  const connectionOptions = { ...options, headers: new Headers(options.headers ?? undefined) };
  let connection: WebsocketConnection | null = null;
  return {
    onOpen(_evt, ws) {
      const conn = new WebsocketConnection(
        {
          // Copy into a fresh ArrayBuffer-backed view, the type Hono accepts.
          send: (data) => ws.send(typeof data === "string" ? data : data.slice()),
          close: (code, reason) => ws.close(code, reason),
        },
        connectionOptions,
      );
      connection = conn;
      createTask(async () => {
        try {
          await handler(conn);
        } catch (e) {
          rethrowIfCancelled(e);
          logger.error("WebSocket handler failed", e);
        } finally {
          await conn.close();
        }
      }, `hono-websocket::${conn}`);
    },
    onMessage(evt) {
      connection?.feedMessage(evt.data);
    },
    onClose(evt) {
      connection?.feedClose(evt.code, evt.reason);
    },
    onError() {
      // An error is followed by a close.
    },
  };
}
