// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The runtime-agnostic socket the WebSocket transports talk to.
 *
 * Upstream's transports sit on the `websockets` package (client and server)
 * and on Starlette's `WebSocket` (FastAPI). Here they sit on
 * `WebsocketConnection`, which wraps anything that can send, close and report
 * messages and closes:
 *
 * - a standard (WHATWG) `WebSocket`: the global `WebSocket` client, the
 *   server side of a Cloudflare `WebSocketPair`, `Deno.upgradeWebSocket`'s
 *   socket, or a Node `ws` socket, with `WebsocketConnection.fromWebSocket()`;
 * - anything else (e.g. Bun's `ServerWebSocket`, whose events arrive through
 *   `Bun.serve` handlers) with `new WebsocketConnection(sink)` plus
 *   `feedMessage()` / `feedClose()`.
 *
 * A connection exposes both APIs the upstream transports use: the
 * `websockets` one (`state`, `recv()`, `send()`, `close()`, async iteration)
 * and the Starlette one (`clientState`, `applicationState`, `receive()`,
 * `sendBytes()`, `sendText()`, `headers`).
 */

import { CancelledError, Future, Queue, TimeoutError, wait } from "@pipedog/asyncio";

/** A WebSocket message: text or binary. */
export type WebsocketData = string | Uint8Array;

/** Connection state, as `websockets.protocol.State`. */
export const State = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
export type State = (typeof State)[keyof typeof State];

/** Connection state, as `starlette.websockets.WebSocketState`. */
export const WebSocketState = {
  CONNECTING: 0,
  CONNECTED: 1,
  DISCONNECTED: 2,
  RESPONSE: 3,
} as const;
export type WebSocketState = (typeof WebSocketState)[keyof typeof WebSocketState];

/** Raised when using a connection that is closed (`websockets.ConnectionClosed`). */
export class ConnectionClosed extends Error {
  override name = "ConnectionClosed";
  /** The close code, or `null` if none was received. */
  code: number | null;
  /** The close reason. */
  reason: string;

  constructor(code: number | null, reason = "") {
    super(code === null ? "no close frame received or sent" : `received ${code} (${reason})`);
    this.code = code;
    this.reason = reason;
  }
}

/** A connection that closed normally (codes 1000, 1001 or no status). */
export class ConnectionClosedOK extends ConnectionClosed {
  override name = "ConnectionClosedOK";
}

/** A connection that closed abnormally. */
export class ConnectionClosedError extends ConnectionClosed {
  override name = "ConnectionClosedError";
}

/** What a connection needs to write to the underlying socket. */
export interface WebsocketSink {
  send(data: WebsocketData): unknown;
  close(code?: number, reason?: string): unknown;
}

/**
 * A standard WebSocket, or anything shaped like one: the global `WebSocket`,
 * Cloudflare's `WebSocketPair` sockets, Deno's upgraded socket, Node's `ws`.
 */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  // `any` on purpose: each runtime types its event listener parameter differently (DOM
  // `MessageEvent`, `ws`'s `WebSocket.MessageEvent`, Cloudflare's types), and a parameter of
  // `unknown` would make none of them assignable. The handlers narrow what they read.
  addEventListener(type: string, listener: (event: any) => void): void;
}

/** A message from `WebsocketConnection.receive()`, shaped like an ASGI message. */
export interface WebsocketReceiveMessage {
  type: "websocket.receive" | "websocket.disconnect";
  bytes?: Uint8Array | null;
  text?: string | null;
  code?: number;
  reason?: string;
}

export interface WebsocketConnectionOptions {
  /** The handshake request's headers (server side). */
  headers?: HeadersInit | null;
  /** The peer's address, for logging. */
  remoteAddress?: string | null;
  /** The request path (server side). */
  path?: string | null;
  /** The initial state. Defaults to `State.OPEN`. */
  state?: State;
  /** Seconds `close()` waits for the closing handshake. Defaults to 10. */
  closeTimeout?: number;
}

const CLOSED_OK_CODES = new Set([1000, 1001, 1005]);

function toUint8Array(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  // Copy: a runtime may reuse the buffer behind a message.
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

/** A WebSocket connection on any runtime. See the module docs. */
export class WebsocketConnection implements AsyncIterable<WebsocketData> {
  /** The handshake request's headers (empty on the client side). */
  readonly headers: Headers;
  /** The peer's address, for logging. */
  readonly remoteAddress: string | null;
  /** The request path (server side). */
  readonly path: string | null;

  #sink: WebsocketSink;
  #state: State;
  #queue = new Queue<WebsocketData | null>();
  #closed = new Future<void>();
  #closeCode: number | null = null;
  #closeReason = "";
  #applicationClosed = false;
  #closeTimeout: number;
  // Set once a message needed asynchronous decoding (a Blob), to keep order.
  #chain: Promise<void> | null = null;

  constructor(sink: WebsocketSink, options: WebsocketConnectionOptions = {}) {
    this.#sink = sink;
    this.headers = new Headers(options.headers ?? undefined);
    this.remoteAddress = options.remoteAddress ?? null;
    this.path = options.path ?? null;
    this.#state = options.state ?? State.OPEN;
    this.#closeTimeout = options.closeTimeout ?? 10;
  }

  /**
   * Wrap a standard WebSocket.
   *
   * @param ws The socket.
   * @param options Connection details (headers, remote address...).
   */
  static fromWebSocket(
    ws: WebSocketLike,
    options: Omit<WebsocketConnectionOptions, "state"> = {},
  ): WebsocketConnection {
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      // Not settable on this runtime; Blobs are handled too.
    }
    const state: State =
      ws.readyState === 0 ? State.CONNECTING : ws.readyState === 1 ? State.OPEN : State.CLOSED;
    const connection = new WebsocketConnection(
      {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      },
      { ...options, state },
    );
    ws.addEventListener("open", () => connection.feedOpen());
    ws.addEventListener("message", (event: { data: unknown }) =>
      connection.feedMessage(event.data),
    );
    ws.addEventListener("close", (event: { code?: number; reason?: string }) =>
      connection.feedClose(event.code, event.reason),
    );
    // An "error" event is always followed by "close".
    ws.addEventListener("error", () => {});
    return connection;
  }

  /** The connection state (`websockets`' `state`). */
  get state(): State {
    return this.#state;
  }

  /** The close code received, once closed. */
  get closeCode(): number | null {
    return this.#closeCode;
  }

  /** The close reason received, once closed. */
  get closeReason(): string {
    return this.#closeReason;
  }

  /** The peer's side of the connection (Starlette's `client_state`). */
  get clientState(): WebSocketState {
    if (this.#state === State.CONNECTING) return WebSocketState.CONNECTING;
    return this.#state === State.CLOSED ? WebSocketState.DISCONNECTED : WebSocketState.CONNECTED;
  }

  /** The application's side of the connection (Starlette's `application_state`). */
  get applicationState(): WebSocketState {
    if (this.#state === State.CONNECTING) return WebSocketState.CONNECTING;
    return this.#applicationClosed || this.#state === State.CLOSED
      ? WebSocketState.DISCONNECTED
      : WebSocketState.CONNECTED;
  }

  /** For adapters: the socket opened. */
  feedOpen(): void {
    if (this.#state === State.CONNECTING) this.#state = State.OPEN;
  }

  /** For adapters: a message arrived. */
  feedMessage(data: unknown): void {
    const isBlob = typeof Blob !== "undefined" && data instanceof Blob;
    if (isBlob || this.#chain) {
      const previous = this.#chain ?? Promise.resolve();
      this.#chain = previous.then(async () => {
        this.#push(isBlob ? new Uint8Array(await (data as Blob).arrayBuffer()) : data);
      });
      return;
    }
    this.#push(data);
  }

  /** For adapters: the socket closed. */
  feedClose(code?: number | null, reason?: string | null): void {
    if (this.#chain) {
      this.#chain = this.#chain.then(() => this.#markClosed(code, reason));
      return;
    }
    this.#markClosed(code, reason);
  }

  #push(data: unknown): void {
    if (this.#state === State.CLOSED) return;
    if (typeof data === "string") {
      this.#queue.putNowait(data);
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      this.#queue.putNowait(toUint8Array(data as ArrayBuffer | ArrayBufferView));
    } else if (Array.isArray(data)) {
      // Node `ws` with binaryType "fragments".
      const parts = data.map((p) => toUint8Array(p as ArrayBufferView));
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
      }
      this.#queue.putNowait(out);
    } else {
      this.#queue.putNowait(String(data));
    }
  }

  #markClosed(code?: number | null, reason?: string | null): void {
    if (this.#state === State.CLOSED) return;
    this.#state = State.CLOSED;
    this.#closeCode = code ?? 1005;
    this.#closeReason = reason ?? "";
    this.#queue.putNowait(null);
    if (!this.#closed.done()) this.#closed.setResult(undefined);
  }

  #closedError(): ConnectionClosed {
    const code = this.#closeCode;
    if (code !== null && CLOSED_OK_CODES.has(code)) {
      return new ConnectionClosedOK(code, this.#closeReason);
    }
    return new ConnectionClosedError(code, this.#closeReason);
  }

  /**
   * Receive the next message (`websockets`' `recv()`).
   *
   * @throws ConnectionClosed once the connection is closed and drained.
   */
  async recv(): Promise<WebsocketData> {
    const message = await this.#queue.get();
    if (message === null) {
      // Leave the marker for any other reader.
      this.#queue.putNowait(null);
      throw this.#closedError();
    }
    return message;
  }

  /**
   * Iterate over incoming messages. Ends when the connection closes normally
   * and throws `ConnectionClosedError` when it closes abnormally, as
   * `websockets` does.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<WebsocketData> {
    for (;;) {
      try {
        yield await this.recv();
      } catch (e) {
        if (e instanceof ConnectionClosedOK) return;
        throw e;
      }
    }
  }

  /**
   * Send a message.
   *
   * @throws ConnectionClosed if the connection isn't open.
   */
  async send(data: WebsocketData): Promise<void> {
    if (this.#state !== State.OPEN) {
      throw this.#state === State.CLOSED ? this.#closedError() : new ConnectionClosedOK(null);
    }
    await this.#sink.send(data);
  }

  /** Send a binary message (Starlette's `send_bytes()`). */
  async sendBytes(data: Uint8Array): Promise<void> {
    await this.send(data);
  }

  /** Send a text message (Starlette's `send_text()`). */
  async sendText(data: string): Promise<void> {
    await this.send(data);
  }

  /**
   * Receive the next message as an ASGI-style message (Starlette's
   * `receive()`): a `websocket.receive` with `bytes` or `text`, or a
   * `websocket.disconnect` once the connection is closed.
   */
  async receive(): Promise<WebsocketReceiveMessage> {
    try {
      const message = await this.recv();
      return typeof message === "string"
        ? { type: "websocket.receive", bytes: null, text: message }
        : { type: "websocket.receive", bytes: message, text: null };
    } catch (e) {
      if (e instanceof ConnectionClosed) {
        return { type: "websocket.disconnect", code: e.code ?? 1005, reason: e.reason };
      }
      throw e;
    }
  }

  /**
   * Close the connection and wait (at most the close timeout) for the
   * closing handshake to finish.
   *
   * @param code The close code. Defaults to 1000.
   * @param reason The close reason.
   */
  async close(code = 1000, reason = ""): Promise<void> {
    this.#applicationClosed = true;
    if (this.#state === State.CLOSED) return;
    if (this.#state !== State.CLOSING) {
      this.#state = State.CLOSING;
      try {
        await this.#sink.close(code, reason);
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        this.#markClosed(1006, "");
        return;
      }
    }
    const [done] = await wait([this.#closed], { timeout: this.#closeTimeout });
    if (done.size === 0) {
      // The peer never answered the closing handshake.
      this.#markClosed(1006, "");
    }
  }

  toString(): string {
    return `WebsocketConnection(${this.remoteAddress ?? this.path ?? ""})`;
  }
}

export interface WebsocketConnectOptions {
  /** Seconds to wait for the connection to open. Defaults to 10. */
  openTimeout?: number;
  /**
   * Extra headers for the handshake. Bun, Node and Deno support them; browsers
   * and Cloudflare Workers don't.
   */
  additionalHeaders?: Record<string, string> | null;
}

/** A function that opens a client connection, as `websocketConnect`. */
export type WebsocketConnectFn = (
  uri: string,
  options?: WebsocketConnectOptions,
) => Promise<WebsocketConnection>;

/**
 * Open a client connection with the global `WebSocket`
 * (`websockets.asyncio.client.connect`).
 *
 * @throws TimeoutError if the connection doesn't open in time.
 */
export async function websocketConnect(
  uri: string,
  options: WebsocketConnectOptions = {},
): Promise<WebsocketConnection> {
  const WebSocketCtor = (globalThis as { WebSocket?: new (...args: unknown[]) => WebSocketLike })
    .WebSocket;
  if (!WebSocketCtor) {
    throw new Error("No global WebSocket is available on this runtime");
  }
  const headers = options.additionalHeaders;
  const ws =
    headers && Object.keys(headers).length > 0
      ? new WebSocketCtor(uri, { headers })
      : new WebSocketCtor(uri);
  const connection = WebsocketConnection.fromWebSocket(ws);
  const opened = new Future<void>();
  ws.addEventListener("open", () => {
    if (!opened.done()) opened.setResult(undefined);
  });
  ws.addEventListener("close", (event: { code?: number; reason?: string }) => {
    if (!opened.done()) {
      opened.setException(
        new ConnectionClosedError(event.code ?? 1006, event.reason ?? "connection failed"),
      );
    }
  });
  try {
    const [done] = await wait([opened], { timeout: options.openTimeout ?? 10 });
    if (done.size === 0) {
      throw new TimeoutError(`timed out while opening ${uri}`);
    }
    opened.result();
  } catch (e) {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    throw e;
  }
  return connection;
}
