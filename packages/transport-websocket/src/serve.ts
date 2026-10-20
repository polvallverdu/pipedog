// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * WebSocket servers for each runtime (`websockets.asyncio.server.serve`).
 *
 * `websocketServe()` listens on a host and port with the runtime's own
 * server: `Bun.serve` on Bun, `Deno.serve` on Deno, and the `ws` package
 * (an optional peer dependency) on Node. Cloudflare Workers can't listen on a
 * port: accept the socket with a `WebSocketPair` and hand it to
 * `FastAPIWebsocketTransport` instead.
 *
 * Every accepted connection runs the handler in its own task. Closing the
 * server closes the open connections (code 1001) and waits for their
 * handlers, as leaving `async with serve(...)` does upstream.
 */

import { createTask, rethrowIfCancelled, type Task, wait } from "@pipedog/asyncio";
import { logger } from "@pipedog/core/utils/logger";

import { WebsocketConnection } from "./socket.ts";

export interface WebsocketServeOptions {
  /** Runs for every accepted connection. */
  handler: (websocket: WebsocketConnection) => Promise<void>;
  /** The host to listen on. */
  host: string;
  /** The port to listen on. */
  port: number;
  /**
   * Accepted `Origin` header values; `null` accepts any. A connection whose
   * origin isn't listed is rejected with HTTP 403.
   */
  origins?: string[] | null;
}

/** A listening server. */
export interface WebsocketServer {
  /** Stop listening, close the connections and wait for their handlers. */
  close(): Promise<void>;
}

/** A function that starts a server, as `websocketServe`. */
export type WebsocketServe = (options: WebsocketServeOptions) => Promise<WebsocketServer>;

type Any = any;

/** Runs the handler of each connection and closes them all on shutdown. */
class ConnectionTracker {
  #handler: (websocket: WebsocketConnection) => Promise<void>;
  #connections = new Map<WebsocketConnection, Task<void>>();

  constructor(handler: (websocket: WebsocketConnection) => Promise<void>) {
    this.#handler = handler;
  }

  handle(connection: WebsocketConnection): void {
    const task = createTask(async () => {
      try {
        await this.#handler(connection);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error("connection handler failed", e);
      } finally {
        this.#connections.delete(connection);
        await connection.close();
      }
    }, `websocket-server::${connection}`);
    this.#connections.set(connection, task);
  }

  async close(): Promise<void> {
    const connections = [...this.#connections];
    await Promise.all(connections.map(([c]) => c.close(1001, "going away")));
    const tasks = connections.map(([, t]) => t);
    if (tasks.length > 0) await wait(tasks);
  }
}

function isOriginRejected(origins: string[] | null | undefined, origin: string | null): boolean {
  return !!origins && (origin === null || !origins.includes(origin));
}

function forbidden(): Response {
  return new Response("Failed to open a WebSocket connection: invalid Origin header.\n", {
    status: 403,
  });
}

function upgradeRequired(): Response {
  return new Response("Failed to open a WebSocket connection: expected an upgrade.\n", {
    status: 426,
  });
}

async function serveBun(options: WebsocketServeOptions): Promise<WebsocketServer> {
  const Bun = (globalThis as Any).Bun;
  const tracker = new ConnectionTracker(options.handler);
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch(req: Request, srv: Any) {
      if (isOriginRejected(options.origins, req.headers.get("origin"))) return forbidden();
      const ip = srv.requestIP(req);
      const data = {
        headers: req.headers,
        path: new URL(req.url).pathname,
        remoteAddress: ip ? `${ip.address}:${ip.port}` : null,
        connection: null as WebsocketConnection | null,
      };
      if (srv.upgrade(req, { data })) return undefined;
      return upgradeRequired();
    },
    websocket: {
      open(ws: Any) {
        const connection = new WebsocketConnection(
          {
            send: (message) => ws.send(message),
            close: (code, reason) => ws.close(code, reason),
          },
          { headers: ws.data.headers, path: ws.data.path, remoteAddress: ws.data.remoteAddress },
        );
        ws.data.connection = connection;
        tracker.handle(connection);
      },
      message(ws: Any, message: unknown) {
        ws.data.connection?.feedMessage(message);
      },
      close(ws: Any, code: number, reason: string) {
        ws.data.connection?.feedClose(code, reason);
      },
    },
  });
  return {
    async close() {
      server.stop(false);
      await tracker.close();
      server.stop(true);
    },
  };
}

async function serveDeno(options: WebsocketServeOptions): Promise<WebsocketServer> {
  const Deno = (globalThis as Any).Deno;
  const tracker = new ConnectionTracker(options.handler);
  const abort = new AbortController();
  const server = Deno.serve(
    { hostname: options.host, port: options.port, signal: abort.signal, onListen() {} },
    (req: Request, info: Any) => {
      if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        return upgradeRequired();
      }
      if (isOriginRejected(options.origins, req.headers.get("origin"))) return forbidden();
      // Read the request first: once upgraded, it is closed and its headers,
      // URL and `info.remoteAddr` throw.
      const addr = info?.remoteAddr;
      const headers = new Headers(req.headers);
      const path = new URL(req.url).pathname;
      const { socket, response } = Deno.upgradeWebSocket(req);
      const connection = WebsocketConnection.fromWebSocket(socket, {
        headers,
        path,
        remoteAddress: addr ? `${addr.hostname}:${addr.port}` : null,
      });
      socket.addEventListener("open", () => tracker.handle(connection));
      return response;
    },
  );
  return {
    async close() {
      await tracker.close();
      abort.abort();
      await server.finished;
    },
  };
}

async function serveNode(options: WebsocketServeOptions): Promise<WebsocketServer> {
  // `ws` is an optional peer dependency, only needed on Node.
  const moduleName = "ws";
  let ws: Any;
  try {
    ws = await import(moduleName);
  } catch (e) {
    rethrowIfCancelled(e);
    throw new Error("In order to serve WebSockets on Node, you need to install the `ws` package.", {
      cause: e,
    });
  }
  const WebSocketServer = ws.WebSocketServer ?? ws.default?.WebSocketServer;
  const tracker = new ConnectionTracker(options.handler);
  const origins = options.origins;
  const wss = new WebSocketServer({
    host: options.host,
    port: options.port,
    verifyClient: origins
      ? (info: { origin?: string }, done: (ok: boolean, code?: number) => void) =>
          done(!isOriginRejected(origins, info.origin ?? null), 403)
      : undefined,
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  wss.on("connection", (socket: Any, req: Any) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else if (typeof value === "string") headers.set(name, value);
    }
    const connection = WebsocketConnection.fromWebSocket(socket, {
      headers,
      path: req.url ?? null,
      remoteAddress: req.socket ? `${req.socket.remoteAddress}:${req.socket.remotePort}` : null,
    });
    tracker.handle(connection);
  });
  return {
    async close() {
      await tracker.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * Start a WebSocket server with the runtime's own server. See the module docs.
 *
 * @throws Error on runtimes that can't listen on a port (Cloudflare Workers).
 */
export const websocketServe: WebsocketServe = async (options) => {
  const g = globalThis as Any;
  const workerd = g.navigator?.userAgent === "Cloudflare-Workers";
  if (g.Bun) return await serveBun(options);
  if (g.Deno) return await serveDeno(options);
  if (!workerd && g.process?.versions?.node) return await serveNode(options);
  throw new Error(
    "This runtime can't listen for WebSocket connections; accept the socket yourself " +
      "(e.g. with a WebSocketPair) and use FastAPIWebsocketTransport.",
  );
};
