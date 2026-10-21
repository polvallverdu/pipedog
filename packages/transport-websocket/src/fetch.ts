// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// WebSocket endpoints as fetch handlers, `(Request, server?) => Promise<Response>`.
// The handler upgrades the request and returns the response that completes the
// upgrade; the connection goes to `onConnection`. Hono, Next.js, SvelteKit and
// oRPC route to the same handler.
//
// How the upgrade happens depends on the runtime:
//
// - Cloudflare Workers and Durable Objects: a `WebSocketPair`.
// - Deno: `Deno.upgradeWebSocket`.
// - Bun: the server's `upgrade()`. Pass the `server` Bun hands to `fetch`, and
//   give `Bun.serve` the `bunWebSocket` handlers, which deliver the socket's
//   events: `Bun.serve({ fetch: (req, server) => handler(req, server), websocket: bunWebSocket })`.
// - Node: no fetch server upgrades on its own; `serveFetch()` (serve.ts) passes
//   a server whose `upgrade()` accepts the socket with the `ws` package.

import { createTask, rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";
import { type WebSocketLike, WebsocketConnection } from "./socket.ts";

/** The response that completes a WebSocket upgrade, and the server side of the socket. */
export interface UpgradedWebSocket {
  response: Response;
  socket: WebSocketLike;
}

/**
 * A server that upgrades requests itself: Bun's `Server` (the second argument
 * of `Bun.serve`'s `fetch`), or the Node server of `serveFetch()`. The upgraded
 * socket's events reach `data` through `bunWebSocket` (Bun) or the server.
 */
export interface UpgradingServer {
  upgrade(request: Request, options?: { data?: unknown; headers?: HeadersInit }): boolean;
}

export interface UpgradeWebSocketOptions {
  /** The server to upgrade with, on Bun (and with `serveFetch()` on Node). */
  server?: UpgradingServer | null;
}

const BRIDGE = Symbol.for("pipedog.websocketBridge");

/** The socket events a server delivers to a bridged socket. */
interface BridgeSink {
  send(data: string | ArrayBufferLike | ArrayBufferView): unknown;
  close(code?: number, reason?: string): unknown;
}

/**
 * A standard-shaped WebSocket over a server-side socket whose events arrive
 * through server callbacks (Bun's `ServerWebSocket`, a Node `ws` socket):
 * `CONNECTING` until the server opens it, then `OPEN`, then `CLOSED`.
 */
export class ServerWebSocketBridge implements WebSocketLike {
  readyState = 0;
  binaryType = "arraybuffer";
  #sink: BridgeSink | null = null;
  #listeners = new Map<string, ((event: any) => void)[]>();
  #pending: (() => void)[] = [];

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== 1 || !this.#sink) throw new Error("WebSocket is not open");
    this.#sink.send(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    if (!this.#sink) {
      // Not open yet: close as soon as it opens.
      this.#pending.push(() => this.close(code, reason));
      return;
    }
    this.readyState = 2;
    this.#sink.close(code, reason);
  }

  /** For servers: the socket is open; `sink` writes to it. */
  _open(sink: BridgeSink): void {
    this.#sink = sink;
    this.readyState = 1;
    this.#emit("open", {});
    for (const run of this.#pending.splice(0)) run();
  }

  /** For servers: a message arrived. */
  _message(data: unknown): void {
    this.#emit("message", { data });
  }

  /** For servers: the socket closed. */
  _close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { code: code ?? 1005, reason: reason ?? "" });
  }
}

type BunServerWebSocket = {
  data: unknown;
  send(data: string | ArrayBufferLike | ArrayBufferView): unknown;
  close(code?: number, reason?: string): unknown;
};

/** The bridge a server's upgrade `data` carries (see `bridgeData`), if any. */
export function bridgeFromData(data: unknown): ServerWebSocketBridge | undefined {
  const bridge = (data as { [BRIDGE]?: unknown } | null | undefined)?.[BRIDGE];
  return bridge instanceof ServerWebSocketBridge ? bridge : undefined;
}

function bridgeOf(ws: BunServerWebSocket): ServerWebSocketBridge | undefined {
  return bridgeFromData(ws.data);
}

/**
 * `Bun.serve`'s `websocket` handlers for sockets upgraded with
 * `upgradeWebSocket(request, { server })`. Sockets upgraded by other code
 * (without the bridge in their `data`) are ignored, so they can share a server
 * with your own handlers if you call these from yours.
 */
export const bunWebSocket = {
  open(ws: BunServerWebSocket): void {
    bridgeOf(ws)?._open({
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    });
  },
  message(ws: BunServerWebSocket, message: unknown): void {
    bridgeOf(ws)?._message(message);
  },
  close(ws: BunServerWebSocket, code: number, reason: string): void {
    bridgeOf(ws)?._close(code, reason);
  },
};

/** The `data` to attach to a socket a server upgrades, so its events reach `bridge`. */
export function bridgeData(bridge: ServerWebSocketBridge): Record<symbol, unknown> {
  return { [BRIDGE]: bridge };
}

/**
 * The placeholder response for a request a server upgraded: 101 where the
 * runtime allows it (Bun), 200 where `Response` refuses 1xx statuses (Node).
 * The server ignores it either way.
 */
function upgradedResponse(): Response {
  try {
    return new Response(null, { status: 101 });
  } catch {
    return new Response(null, { status: 200 });
  }
}

/**
 * Upgrade `request` to a WebSocket, from fetch.
 *
 * On Bun, pass the `server` from `fetch(request, server)` and serve with the
 * `bunWebSocket` handlers. The returned response is a placeholder (status
 * 101) that Bun ignores once the request is upgraded; return it from `fetch`.
 *
 * @throws Error on a runtime that can't upgrade from fetch, or on Bun without `server`.
 */
export function upgradeWebSocket(
  request: Request,
  options: UpgradeWebSocketOptions = {},
): UpgradedWebSocket {
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
  if (options.server) {
    const bridge = new ServerWebSocketBridge();
    if (!options.server.upgrade(request, { data: bridgeData(bridge) })) {
      throw new Error("The server refused to upgrade the request to a WebSocket.");
    }
    return { response: upgradedResponse(), socket: bridge };
  }
  if (g.Bun) {
    throw new Error(
      "Bun can't upgrade a Request to a WebSocket from fetch on its own: pass the `server` Bun gives `fetch` " +
        "(`upgradeWebSocket(request, { server })` or `handler(request, server)`) and serve " +
        "with `websocket: bunWebSocket`, or use `serveFetch()`.",
    );
  }
  throw new Error(
    "This runtime can't upgrade a Request to a WebSocket from fetch. On Node, serve the " +
      "handler with `serveFetch()` (which upgrades with the `ws` package).",
  );
}

/**
 * A fetch handler for a WebSocket endpoint. Each upgraded connection is handed
 * to `onConnection` as a `WebsocketConnection`, which runs in its own task; the
 * connection closes when the task ends.
 *
 * The second argument is the upgrading server, on Bun (see `upgradeWebSocket`).
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
 *
 * @example
 * // Bun
 * const handler = websocketFetchHandler(runVoiceBot);
 * Bun.serve({ fetch: (req, server) => handler(req, server), websocket: bunWebSocket });
 */
export function websocketFetchHandler(
  onConnection: (connection: WebsocketConnection) => void | Promise<void>,
): (request: Request, server?: UpgradingServer | null) => Promise<Response> {
  return async (request: Request, server?: UpgradingServer | null): Promise<Response> => {
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
    const { response, socket } = upgradeWebSocket(request, { server });
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
