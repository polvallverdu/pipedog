// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * WebSocket connections accepted on the main thread, served by a bot in a
 * worker thread.
 *
 * A socket can't move to another thread, so the main thread keeps it and
 * forwards its messages: `forwardConnection()` on the main thread posts each
 * message to a worker (binary frames are transferred, not copied), and
 * `acceptConnections()` in the worker hands the bot a `WebsocketConnection`
 * that behaves like the real one. Everything built on `WebsocketConnection`
 * runs unchanged in the worker: the WebSocket transports, and the telephony
 * serializers (Twilio, Telnyx, Plivo, ...). One worker serves many
 * connections over one port.
 */

import {
  ConnectionClosed,
  WebsocketConnection,
  type WebsocketData,
} from "@pipedog/transport-websocket/socket";
import type { ThreadPort } from "./threads.ts";

type Message =
  | { type: "ws:open"; id: number; headers: [string, string][]; path: string | null }
  | { type: "ws:data"; id: number; data: WebsocketData }
  | { type: "ws:closed"; id: number; code: number; reason: string }
  | { type: "ws:send"; id: number; data: WebsocketData }
  | { type: "ws:close"; id: number; code?: number; reason?: string };

let nextId = 0;

/** Moves a message's bytes when they are a whole buffer of their own; copies otherwise. */
function post(port: ThreadPort, message: Message): void {
  const data = "data" in message ? message.data : null;
  if (
    data instanceof Uint8Array &&
    data.byteOffset === 0 &&
    data.byteLength === data.buffer.byteLength
  ) {
    port.postMessage(message, [data.buffer as ArrayBuffer]);
  } else {
    port.postMessage(message);
  }
}

export interface ForwardConnectionOptions {
  /** The handshake request's headers, for the worker's connection. */
  headers?: Headers | null;
  /** The request path, for the worker's connection. */
  path?: string | null;
}

/**
 * Main thread: serves `connection` from the worker behind `port` until either
 * side closes it. Resolves when the connection has closed.
 *
 * @example
 * ```ts
 * const handler = websocketFetchHandler((connection) => forwardConnection(connection, pickWorker()));
 * ```
 */
export async function forwardConnection(
  connection: WebsocketConnection,
  port: ThreadPort,
  options: ForwardConnectionOptions = {},
): Promise<void> {
  const id = nextId++;
  const removeListener = port.addListener((msg: Message) => {
    if (msg?.id !== id) return;
    if (msg.type === "ws:send") {
      connection.send(msg.data).catch((e) => {
        if (!(e instanceof ConnectionClosed)) throw e;
      });
    } else if (msg.type === "ws:close") {
      void connection.close(msg.code, msg.reason);
    }
  });
  post(port, {
    type: "ws:open",
    id,
    headers: options.headers ? [...options.headers] : [],
    path: options.path ?? null,
  });
  try {
    for (;;) {
      const message = await connection.receive();
      if (message.type === "websocket.disconnect") {
        post(port, {
          type: "ws:closed",
          id,
          code: message.code ?? 1005,
          reason: message.reason ?? "",
        });
        return;
      }
      post(port, { type: "ws:data", id, data: message.bytes ?? message.text ?? "" });
    }
  } finally {
    removeListener();
  }
}

/**
 * Worker thread: runs `onConnection` for each connection the main thread
 * forwards on `port`, with a `WebsocketConnection` for it. The connection is
 * closed when `onConnection` returns.
 */
export function acceptConnections(
  port: ThreadPort,
  onConnection: (connection: WebsocketConnection) => Promise<void>,
): void {
  const connections = new Map<number, WebsocketConnection>();
  port.addListener((msg: Message) => {
    if (msg?.type === "ws:open") {
      const { id } = msg;
      const connection = new WebsocketConnection(
        {
          send: (data) => post(port, { type: "ws:send", id, data }),
          close: (code, reason) => post(port, { type: "ws:close", id, code, reason }),
        },
        { headers: msg.headers, path: msg.path },
      );
      connections.set(id, connection);
      (async () => {
        try {
          await onConnection(connection);
        } catch (e) {
          console.error("connection handler failed", e);
        } finally {
          await connection.close();
          connections.delete(id);
        }
      })();
    } else if (msg?.type === "ws:data") {
      connections.get(msg.id)?.feedMessage(msg.data);
    } else if (msg?.type === "ws:closed") {
      connections.get(msg.id)?.feedClose(msg.code, msg.reason);
    }
  });
}
