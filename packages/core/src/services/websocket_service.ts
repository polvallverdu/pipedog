// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/websocket_service.py

/**
 * Base websocket service with automatic reconnection and error handling.
 *
 * Porting notes: upstream connects with the `websockets` library. Here the
 * global `WebSocket` (Bun, Node ≥ 22, Deno, browsers) is wrapped in
 * `WebsocketClientConnection`, which offers the subset of the `websockets`
 * client API services use: `send()`, `recv()`, `async for`, `ping()`,
 * `close()`, `state`, and the `ConnectionClosed` / `ConnectionClosedOK` /
 * `ConnectionClosedError` exceptions. Awaiting `recv()` is a cancellation
 * point, so cancelling a receive task stops it right away.
 *
 * Deprecated upstream and not ported: `WebsocketService.send_with_retry`
 * (deprecated since 1.14.0, no replacement). Send on the websocket directly and
 * leave reconnecting to the receive loop.
 */

import {
  CancelledError,
  type Event,
  monotonic,
  rethrowIfCancelled,
  sleep,
  suspend,
  TimeoutError,
  timeout,
} from "@pipedog/asyncio";
import { ErrorFrame } from "../frames/frames.ts";
import { logger } from "../utils/logger.ts";
import { type Ctor, defineMixin } from "../utils/mixin.ts";
import { exponentialBackoffTime, QuickFailureTracker } from "../utils/network.ts";

/**
 * Reports an error a websocket service ran into.
 *
 * Implemented by the owning service, which usually pairs pushing the error
 * frame with a connection-error event of its own.
 *
 * - `error`: the error frame to report.
 * - `forceTreatAsPermanent`: whether to treat the error as one that will keep
 *   recurring, leaving the service unable to do any more work. Leaving it
 *   false doesn't keep the service usable, since the error's own category may
 *   cost it its usability.
 */
export type ReportErrorCallback = (
  error: ErrorFrame,
  options?: { forceTreatAsPermanent?: boolean },
) => Promise<void>;

/**
 * Default ceiling, in seconds, on the websocket closing handshake. Disconnect
 * runs while a service handles the EndFrame, before the frame continues
 * downstream, so an unacknowledged close delays pipeline shutdown by this
 * much. The `websockets` default of 10s is long enough to be noticeable once
 * several websocket services tear down in sequence.
 */
export const WS_CLOSE_TIMEOUT = 2.0;

/**
 * Default ceiling, in seconds, on a single websocket send. A send only waits
 * once the peer has stopped taking data and the write buffers are full, so on
 * a working connection it returns immediately.
 */
export const WS_SEND_TIMEOUT = 5.0;

/**
 * Bytes buffered on the socket above which a send waits for the buffer to
 * drain, and the level it waits for (`websockets`' default `write_limit` of
 * 32 KiB, whose low-water mark is a quarter of it).
 */
const WS_WRITE_LIMIT_HIGH = 32 * 1024;
const WS_WRITE_LIMIT_LOW = WS_WRITE_LIMIT_HIGH / 4;

/** Seconds between checks of a full write buffer while a send waits on it. */
const WS_DRAIN_POLL_INTERVAL = 0.05;

/** Default time, in seconds, to wait for the opening handshake (as `websockets`). */
export const WS_OPEN_TIMEOUT = 10.0;

//
// Websocket client (stand-in for the `websockets` asyncio client).
//

/** Connection state, with the values of `websockets.protocol.State`. */
export const State = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
export type State = (typeof State)[keyof typeof State];

/** Raised when reading from or writing to a closed connection. */
export class ConnectionClosed extends Error {
  override name = "ConnectionClosed";
  /** The close code, or null if no close frame was received. */
  readonly code: number | null;
  /** The close reason. */
  readonly reason: string;

  constructor(code: number | null, reason: string, message?: string) {
    super(message ?? (code === null ? "no close frame received or sent" : `${code} ${reason}`));
    this.code = code;
    this.reason = reason;
  }
}

/** The connection was closed normally (close code 1000 or 1001). */
export class ConnectionClosedOK extends ConnectionClosed {
  override name = "ConnectionClosedOK";
}

/** The connection was closed with an error (abnormal close code, or none). */
export class ConnectionClosedError extends ConnectionClosed {
  override name = "ConnectionClosedError";
}

/** A message received from a websocket: text, or bytes for a binary frame. */
export type WebsocketData = string | Uint8Array;

type Waiter = {
  resolve: (data: WebsocketData) => void;
  reject: (error: unknown) => void;
};

export interface WebsocketConnectOptions {
  /**
   * Maximum time, in seconds, to wait for the peer to acknowledge the closing
   * handshake before dropping the connection. Defaults to `WS_CLOSE_TIMEOUT`.
   */
  closeTimeout?: number | null;
  /** Maximum time, in seconds, to wait for the opening handshake. */
  openTimeout?: number | null;
  /**
   * Extra HTTP headers for the opening handshake (`additional_headers` in
   * `websockets`). Supported by the Bun, Node (undici) and Deno `WebSocket`,
   * and on Cloudflare Workers, where the socket is opened through `fetch`;
   * on other runtimes pass a `webSocketFactory` that can send them.
   */
  additionalHeaders?: Record<string, string> | null;
  /** Subprotocols to request. */
  subprotocols?: string[] | null;
  /**
   * Creates the underlying `WebSocket`. Defaults to the global `WebSocket`.
   * Use it on runtimes that open websockets differently. Cloudflare Workers
   * need none: there the socket is opened through `fetch` with an `Upgrade`
   * header.
   */
  webSocketFactory?:
    | ((
        uri: string,
        options: { headers?: Record<string, string>; protocols?: string[] },
      ) => WebSocket | Promise<WebSocket>)
    | null;
}

/**
 * A websocket client connection with the asyncio-style API of the
 * `websockets` library, over a standard `WebSocket`.
 *
 * Received messages are buffered until read with `recv()` or `for await`.
 * Binary messages are returned as `Uint8Array`.
 */
export class WebsocketClientConnection {
  readonly #ws: WebSocket;
  readonly #messages: WebsocketData[] = [];
  readonly #waiters = new Set<Waiter>();
  #closed: ConnectionClosed | null = null;
  // The raw close code, as `websockets`' `close_code`: 1006 when no close
  // frame was received, 1005 when one carried no code. The exception's
  // `code` is null in both cases.
  #closeCode: number | null = null;
  readonly #closedWaiters = new Set<() => void>();

  /** Maximum time, in seconds, to wait for the peer to acknowledge a close. */
  closeTimeout: number | null;

  /**
   * Maximum time, in seconds, a single send may wait on a peer that has
   * stopped reading before the connection is dropped (`_BoundedConnection`
   * upstream). Null waits indefinitely.
   */
  sendTimeout: number | null;

  constructor(
    ws: WebSocket,
    options: { closeTimeout?: number | null; sendTimeout?: number | null } = {},
  ) {
    this.#ws = ws;
    this.closeTimeout =
      options.closeTimeout === undefined ? WS_CLOSE_TIMEOUT : options.closeTimeout;
    this.sendTimeout = options.sendTimeout ?? null;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event: MessageEvent) => this.#onMessage(event.data));
    ws.addEventListener("close", (event: CloseEvent) => this.#onClose(event.code, event.reason));
    if (ws.readyState === WebSocket.CLOSED) this.#onClose(1006, "");
  }

  /** The underlying `WebSocket`. */
  get webSocket(): WebSocket {
    return this.#ws;
  }

  /** The connection state. */
  get state(): State {
    if (this.#closed) return State.CLOSED;
    return this.#ws.readyState as State;
  }

  /** The close code, once the connection is closed. */
  get closeCode(): number | null {
    return this.#closeCode;
  }

  /** The close reason, once the connection is closed. */
  get closeReason(): string | null {
    return this.#closed?.reason ?? null;
  }

  /**
   * Send a text (string) or binary (bytes) message, dropping the connection if
   * the send stalls.
   *
   * A send only waits once the peer has stopped taking data and the socket's
   * write buffer is full. `sendTimeout` bounds that wait: once it expires the
   * connection is dropped rather than closed, since a closing handshake writes
   * to the same full buffer and would wait just as long. The drop releases
   * anything else waiting on the connection, and the send fails the way any
   * dropped connection does, so callers' `ConnectionClosed` handling and the
   * receive loop's reconnect take over.
   *
   * DIVERGENCE: the `WebSocket` API never blocks a send; it buffers. Waiting on
   * a full buffer is emulated by polling `bufferedAmount` until it drains to
   * the low-water mark. Runtimes that don't report `bufferedAmount` never wait.
   *
   * @throws ConnectionClosed if the connection is closing or closed.
   * @throws ConnectionClosedError if the send did not complete within
   *   `sendTimeout`.
   */
  async send(message: WebsocketData | ArrayBuffer): Promise<void> {
    if (this.#closed) throw this.#closed;
    if (this.#ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionClosedError(null, "", "websocket is not open");
    }
    this.#ws.send(message as string | ArrayBufferView<ArrayBuffer> | ArrayBuffer);
    if (!(this.#ws.bufferedAmount > WS_WRITE_LIMIT_HIGH)) return;

    const deadline = this.sendTimeout === null ? null : monotonic() + this.sendTimeout;
    while (!this.#closed && this.#ws.bufferedAmount > WS_WRITE_LIMIT_LOW) {
      if (deadline !== null && monotonic() >= deadline) {
        logger.warning(
          `Websocket send to ${this.#peer()} did not complete within ${this.sendTimeout}s; ` +
            "the peer has stopped reading, dropping the connection",
        );
        // Mark the connection closed (code 1006) first, releasing every
        // waiter, then drop the socket and its unsent data.
        this.#onClose(1006, "");
        try {
          this.#ws.close();
        } catch {
          // Already closing; nothing else to release.
        }
        throw this.#closed ?? new ConnectionClosedError(null, "");
      }
      const remaining = deadline === null ? WS_DRAIN_POLL_INTERVAL : deadline - monotonic();
      await sleep(Math.max(0, Math.min(WS_DRAIN_POLL_INTERVAL, remaining)));
    }
    if (this.#closed) throw this.#closed;
  }

  /** The peer's address, for logs. */
  #peer(): string {
    try {
      return new URL(this.#ws.url).host;
    } catch {
      return this.#ws.url;
    }
  }

  /**
   * Receive the next message. A cancellation point.
   *
   * @throws ConnectionClosedOK / ConnectionClosedError once the connection
   *   is closed and every buffered message has been read.
   */
  async recv(): Promise<WebsocketData> {
    const message = this.#messages.shift();
    if (message !== undefined) return message;
    if (this.#closed) throw this.#closed;
    let waiter: Waiter | undefined;
    return await suspend<WebsocketData>((resolve, reject) => {
      waiter = { resolve, reject };
      this.#waiters.add(waiter);
      return () => {
        if (waiter) this.#waiters.delete(waiter);
      };
    });
  }

  /**
   * Iterate over incoming messages. Ends when the connection closes normally;
   * throws `ConnectionClosedError` when it closes with an error.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<WebsocketData, void, unknown> {
    while (true) {
      try {
        yield await this.recv();
      } catch (e) {
        if (e instanceof ConnectionClosedOK) return;
        throw e;
      }
    }
  }

  /**
   * Check the connection is alive.
   *
   * The standard `WebSocket` API cannot send ping frames (runtimes answer the
   * peer's pings themselves), so this only checks the connection is open.
   *
   * @throws ConnectionClosed if the connection is closing or closed.
   */
  async ping(): Promise<void> {
    if (this.#closed) throw this.#closed;
    if (this.#ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionClosedError(null, "", "websocket is not open");
    }
  }

  /**
   * Perform the closing handshake, waiting at most `closeTimeout` seconds for
   * the peer to acknowledge it. Logs if the peer never acknowledged it, which
   * keeps a teardown that silently cost `closeTimeout` from going unnoticed.
   *
   * @param code WebSocket close code.
   * @param reason WebSocket close reason.
   */
  async close(code = 1000, reason = ""): Promise<void> {
    if (this.#closed) return;
    const start = monotonic();
    try {
      if (this.#ws.readyState === WebSocket.CONNECTING || this.#ws.readyState === WebSocket.OPEN) {
        this.#ws.close(code, reason);
      }
      await this.#waitClosed(this.closeTimeout);
    } finally {
      const elapsed = monotonic() - start;
      if (!this.#closed) {
        // The peer never acknowledged the close; drop the connection.
        this.#onClose(1006, "");
      }
      if (this.closeTimeout !== null && elapsed >= this.closeTimeout) {
        // Immediately follows the owning service's "Disconnecting from ..."
        // log, so the connection needs no further identification.
        logger.debug(
          `Peer did not acknowledge the websocket close within ${this.closeTimeout}s; connection dropped`,
        );
      }
    }
  }

  async #waitClosed(timeout: number | null): Promise<void> {
    if (this.#closed) return;
    let done: (() => void) | undefined;
    await suspend<void>((resolve) => {
      done = () => resolve();
      this.#closedWaiters.add(done);
      const timer = timeout === null ? undefined : setTimeout(resolve, Math.max(0, timeout * 1000));
      return () => {
        if (timer) clearTimeout(timer);
        if (done) this.#closedWaiters.delete(done);
      };
    }).finally(() => {
      if (done) this.#closedWaiters.delete(done);
    });
  }

  #onMessage(data: unknown): void {
    let message: WebsocketData;
    if (typeof data === "string") {
      message = data;
    } else if (data instanceof ArrayBuffer) {
      message = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      message = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      message = String(data);
    }
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter.resolve(message);
    } else {
      this.#messages.push(message);
    }
  }

  #onClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closeCode = code;
    this.#closed =
      code === 1000 || code === 1001
        ? new ConnectionClosedOK(code, reason)
        : new ConnectionClosedError(code === 1005 || code === 1006 ? null : code, reason);
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter.reject(this.#closed);
    const closedWaiters = [...this.#closedWaiters];
    this.#closedWaiters.clear();
    for (const done of closedWaiters) done();
  }
}

/**
 * Open a websocket on Cloudflare Workers. Workers' WebSocket constructor can't
 * send headers, which most services authenticate with, so the connection is
 * made with `fetch()` and an `Upgrade: websocket` header, the Workers way to
 * send them. The returned socket is open once accepted.
 */
async function connectWorkersWebSocket(
  uri: string,
  init: { headers?: Record<string, string>; protocols?: string[] },
  openTimeout: number | null,
): Promise<WebSocket> {
  const headers: Record<string, string> = { ...(init.headers ?? {}), Upgrade: "websocket" };
  if (init.protocols?.length) headers["Sec-WebSocket-Protocol"] = init.protocols.join(", ");
  const response = await fetch(uri.replace(/^ws(s?):/i, "http$1:"), {
    headers,
    signal: openTimeout === null ? undefined : AbortSignal.timeout(openTimeout * 1000),
  });
  const ws = (response as Response & { webSocket?: WebSocket & { accept(): void } }).webSocket;
  if (!ws) {
    throw new Error(`websocket connection to ${uri} failed: HTTP ${response.status}`);
  }
  ws.accept();
  return ws;
}

/**
 * Open a websocket connection (`websockets.asyncio.client.connect`).
 * Waiting for the opening handshake is a cancellation point; a cancelled or
 * timed-out attempt closes the socket.
 *
 * @param uri The websocket URI to connect to.
 * @returns The connected websocket.
 */
export async function websocketConnect(
  uri: string,
  options: WebsocketConnectOptions = {},
): Promise<WebsocketClientConnection> {
  const init: { headers?: Record<string, string>; protocols?: string[] } = {};
  if (options.additionalHeaders) init.headers = options.additionalHeaders;
  if (options.subprotocols) init.protocols = options.subprotocols;

  const openTimeout = options.openTimeout === undefined ? WS_OPEN_TIMEOUT : options.openTimeout;

  let ws: WebSocket;
  if (options.webSocketFactory) {
    ws = await options.webSocketFactory(uri, init);
  } else if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function") {
    // Cloudflare Workers.
    ws = await connectWorkersWebSocket(uri, init, openTimeout);
  } else if (init.headers) {
    // Bun, Node (undici) and Deno accept an init object with headers.
    const WebSocketWithInit = WebSocket as unknown as new (
      url: string,
      init: { headers?: Record<string, string>; protocols?: string[] },
    ) => WebSocket;
    ws = new WebSocketWithInit(uri, init);
  } else {
    ws = new WebSocket(uri, init.protocols);
  }

  // Attach the listeners before the socket can deliver anything.
  const connection = new WebsocketClientConnection(ws, { closeTimeout: options.closeTimeout });

  try {
    await suspend<void>((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) {
        resolve();
        return () => {};
      }
      const onOpen = () => resolve();
      const onError = () => reject(new Error(`websocket connection to ${uri} failed`));
      const onClose = (event: CloseEvent) =>
        reject(
          new ConnectionClosedError(
            event.code,
            event.reason,
            `websocket connection to ${uri} closed during handshake (${event.code} ${event.reason})`,
          ),
        );
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      const timer =
        openTimeout === null
          ? undefined
          : setTimeout(
              () => reject(new Error(`timed out during opening handshake with ${uri}`)),
              Math.max(0, openTimeout * 1000),
            );
      return () => {
        if (timer) clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
      };
    });
  } catch (e) {
    try {
      ws.close();
    } catch {
      // The socket may not be closable yet; nothing else to release.
    }
    throw e;
  }

  return connection;
}

//
// WebsocketService
//

export interface WebsocketServiceOptions {
  /** Minimum time, in seconds, to wait between reconnection attempts. */
  reconnectBackoffMinWait?: number;
  /** Maximum time, in seconds, to wait between reconnection attempts. */
  reconnectBackoffMaxWait?: number;
  /** Whether to automatically reconnect on connection errors. */
  reconnectOnError?: boolean;
  /**
   * Maximum time, in seconds, to wait for the peer to acknowledge the
   * websocket closing handshake before dropping the connection. Applied to
   * connections opened through `_websocketConnect()`. Increase it for peers
   * that need longer to complete a graceful close.
   */
  wsCloseTimeout?: number;
  /**
   * Maximum time, in seconds, a single send may wait on a peer that has
   * stopped reading before the connection is dropped and the send throws
   * `ConnectionClosedError`. Applied to connections opened through
   * `_websocketConnect()`. Pass `null` to wait indefinitely. Defaults to
   * `WS_SEND_TIMEOUT`.
   */
  wsSendTimeout?: number | null;
}

/** Members a class gets from the `WebsocketService` mixin. */
export interface WebsocketService {
  _websocket: WebsocketClientConnection | null;
  _reconnectBackoffMinWait: number;
  _reconnectBackoffMaxWait: number;
  _reconnectOnError: boolean;
  _wsCloseTimeout: number;
  _wsSendTimeout: number | null;
  _reconnectInProgress: boolean;
  _disconnecting: boolean;
  _quickFailureTracker: QuickFailureTracker;
  _lastConnectTime: number;
  readonly _isServiceUsable: boolean;
  _websocketConnect(
    uri: string,
    options?: WebsocketConnectOptions,
  ): Promise<WebsocketClientConnection>;
  _verifyConnection(): Promise<boolean>;
  _reconnectWebsocket(attemptNumber: number): Promise<boolean>;
  _tryReconnect(options?: {
    maxRetries?: number;
    reportError?: ReportErrorCallback | null;
  }): Promise<boolean>;
  sendWithRetry(message: WebsocketData, reportError: ReportErrorCallback): Promise<void>;
  _maybeTryReconnect(
    errorMessage: string,
    reportError: ReportErrorCallback,
    error?: unknown,
  ): Promise<boolean>;
  _receiveUntilConfirmed(
    messages: AsyncIterator<WebsocketData>,
    confirmed: Event,
    handleMessage: (message: WebsocketData) => Promise<void>,
    timeout: number,
  ): Promise<boolean>;
  _receiveTaskHandler(reportError: ReportErrorCallback): Promise<void>;
  _connect(): Promise<void>;
  _disconnect(): Promise<void>;
  _connectWebsocket(): Promise<void>;
  _disconnectWebsocket(): Promise<void>;
  _receiveMessages(): Promise<void>;
}

/**
 * Base class for websocket-based services with automatic reconnection.
 *
 * Provides websocket connection management, automatic reconnection with
 * exponential backoff, connection verification, and error handling.
 * Subclasses implement service-specific connection and message handling
 * logic (`_connectWebsocket()`, `_disconnectWebsocket()`, `_receiveMessages()`).
 *
 * Reconnection gives up in two ways, both leaving the service unusable: the
 * provider rejects the configuration, which no amount of retrying will fix,
 * or the attempts are exhausted. Errors are reported through a `reportError`
 * callback, which takes the same optional `forceTreatAsPermanent` flag as
 * `FrameProcessor.pushErrorFrame()`, so that giving up and saying so are the
 * same act.
 *
 * A mixin: `class MyService(TTSService, WebsocketService)` upstream is
 * `class MyService extends WebsocketService(TTSService)` here. Its options
 * (`WebsocketServiceOptions`) are read from the constructor's options object.
 */
export const WebsocketService = defineMixin<
  WebsocketService,
  <B extends Ctor>(base: B) => B & (abstract new (...args: any[]) => WebsocketService)
>("WebsocketService", <B extends Ctor>(Base: B) => {
  abstract class WebsocketServiceMixin extends Base implements WebsocketService {
    _websocket: WebsocketClientConnection | null = null;
    _reconnectBackoffMinWait: number;
    _reconnectBackoffMaxWait: number;
    _reconnectOnError: boolean;
    _wsCloseTimeout: number;
    _wsSendTimeout: number | null;
    _reconnectInProgress = false;
    _disconnecting = false;
    // Rapid failure detection: when a server accepts the WebSocket handshake
    // but immediately closes the connection (e.g. invalid API key, policy
    // rejection), exponential backoff won't help because the handshake keeps
    // succeeding. We detect this by tracking how long the connection
    // survives after being established.
    _quickFailureTracker = new QuickFailureTracker();
    _lastConnectTime = 0.0;

    constructor(...args: any[]) {
      super(...args);
      const options = (args[0] ?? {}) as WebsocketServiceOptions;
      this._reconnectBackoffMinWait = options.reconnectBackoffMinWait ?? 4.0;
      this._reconnectBackoffMaxWait = options.reconnectBackoffMaxWait ?? 10.0;
      this._reconnectOnError = options.reconnectOnError ?? true;
      this._wsCloseTimeout = options.wsCloseTimeout ?? WS_CLOSE_TIMEOUT;
      this._wsSendTimeout =
        options.wsSendTimeout === undefined ? WS_SEND_TIMEOUT : options.wsSendTimeout;
    }

    /**
     * Whether the service this is mixed into can still be given work.
     *
     * Always a `FrameProcessor` in practice, but this is a mixin and can't
     * require it.
     */
    get _isServiceUsable(): boolean {
      return (this as { isUsable?: boolean }).isUsable ?? true;
    }

    /**
     * Open a websocket connection with the service's timeouts applied.
     *
     * Wraps `websocketConnect()`, defaulting `closeTimeout` to
     * `wsCloseTimeout` and bounding each send by `wsSendTimeout`. Pass
     * `closeTimeout` explicitly to override it for a service whose peer needs
     * different closing behavior.
     *
     * @param uri The websocket URI to connect to.
     * @param options Additional options passed to `websocketConnect()`.
     * @returns The connected websocket.
     */
    async _websocketConnect(
      uri: string,
      options: WebsocketConnectOptions = {},
    ): Promise<WebsocketClientConnection> {
      const websocket = await websocketConnect(uri, {
        ...options,
        closeTimeout:
          options.closeTimeout === undefined ? this._wsCloseTimeout : options.closeTimeout,
      });
      websocket.sendTimeout = this._wsSendTimeout;
      return websocket;
    }

    /**
     * Verify the websocket connection is active and responsive.
     *
     * @returns True if connection is verified working, false otherwise.
     */
    async _verifyConnection(): Promise<boolean> {
      try {
        if (!this._websocket || this._websocket.state === State.CLOSED) {
          return false;
        }
        await this._websocket.ping();
        return true;
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} connection verification failed: ${errorText(e)}`);
        return false;
      }
    }

    /**
     * Reconnect the websocket with the current attempt number.
     *
     * @param attemptNumber Current retry attempt number for logging.
     * @returns True if reconnection and verification successful.
     * @throws Error if the reconnected websocket fails verification.
     */
    async _reconnectWebsocket(attemptNumber: number): Promise<boolean> {
      logger.warning(`${this} reconnecting (attempt: ${attemptNumber})`);
      await this._disconnectWebsocket();
      await this._connectWebsocket();
      if (!(await this._verifyConnection())) {
        throw new Error(`${this} websocket reconnection failed verification`);
      }
      return true;
    }

    async _tryReconnect(
      options: { maxRetries?: number; reportError?: ReportErrorCallback | null } = {},
    ): Promise<boolean> {
      const maxRetries = options.maxRetries ?? 3;
      const reportError = options.reportError ?? null;

      // Prevent concurrent reconnection attempts
      if (this._reconnectInProgress) {
        logger.warning(`${this} reconnect attempt aborted: already in progress`);
        return false;
      }

      // Reconnecting can't fix whatever made the service unusable.
      if (!this._isServiceUsable) {
        logger.error(`${this} not reconnecting: the service is no longer usable`);
        return false;
      }

      this._reconnectInProgress = true;
      let lastException: unknown = null;
      try {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            logger.warning(`${this} reconnecting, attempt ${attempt}`);
            if (await this._reconnectWebsocket(attempt)) {
              logger.info(`${this} reconnected successfully on attempt ${attempt}`);
              this._lastConnectTime = monotonic();
              return true;
            }
          } catch (e) {
            rethrowIfCancelled(e);
            lastException = e;
            logger.error(`${this} reconnection attempt ${attempt} failed: ${errorText(e)}`);
            if (reportError) {
              await reportError(
                new ErrorFrame({
                  error: `${this} reconnection attempt ${attempt} failed: ${errorText(e)}`,
                  exception: e,
                }),
              );
            }
          }
          // A rejected attempt may have been rejected for a reason reporting
          // it identified as terminal.
          if (!this._isServiceUsable) {
            logger.error(`${this} abandoning reconnection: the service is no longer usable`);
            return false;
          }
          const waitTime = exponentialBackoffTime(
            attempt,
            this._reconnectBackoffMinWait,
            this._reconnectBackoffMaxWait,
          );
          await sleep(waitTime);
        }
        let msg = `${this} failed to reconnect after ${maxRetries} attempts`;
        if (lastException) {
          msg += `: ${errorText(lastException)}`;
        }
        logger.error(msg);
        if (reportError) {
          await reportError(new ErrorFrame({ error: msg, exception: lastException }), {
            forceTreatAsPermanent: true,
          });
        }
        return false;
      } finally {
        this._reconnectInProgress = false;
      }
    }

    /**
     * Attempt to send a message, retrying after reconnect if necessary.
     *
     * Deprecated upstream (1.14.0, no replacement: send on the websocket directly and leave
     * reconnecting to the receive loop). Kept only because the Cartesia turns STT and Inworld TTS
     * ports still call it; remove it once their upstream re-ports land.
     */
    async sendWithRetry(message: WebsocketData, reportError: ReportErrorCallback): Promise<void> {
      try {
        // If websocket isn't connected/present, treat as a send failure — the
        // broad catch below will trigger a reconnect attempt.
        if (this._websocket === null) {
          throw new Error(`${this} no websocket connected`);
        }
        await this._websocket.send(message);
      } catch (e) {
        rethrowIfCancelled(e);
        logger.error(`${this} send failed: ${errorText(e)}, will try to reconnect`);
        // Try to reconnect before retrying
        const success = await this._tryReconnect({ reportError });
        if (success && this._websocket !== null) {
          logger.info(`${this} reconnected successfully, will retry send the message`);
          // trying to send the message one more time
          await this._websocket.send(message);
        } else {
          logger.error(`${this} send failed; unable to reconnect`);
        }
      }
    }

    /**
     * Check if reconnection should be attempted and try if appropriate.
     *
     * @param errorMessage Human-readable error message for logging.
     * @param reportError Callback function to report connection errors.
     * @param error The error that occurred (may be null for graceful closes).
     * @returns True if should continue the receive loop, false if should break.
     */
    async _maybeTryReconnect(
      errorMessage: string,
      reportError: ReportErrorCallback,
      error: unknown = null,
    ): Promise<boolean> {
      // Don't reconnect if we're intentionally disconnecting
      if (this._disconnecting) {
        if (error) {
          logger.warning(`${this} error during disconnect: ${errorText(error)}`);
        } else {
          logger.debug(`${this} receive loop ended during disconnect`);
        }
        return false;
      }

      // Check if the connection died too quickly after being established.
      // This catches cases where the handshake succeeds but the server
      // immediately closes (e.g. invalid API key). Exponential backoff won't
      // help here because the handshake keeps succeeding — we need to stop
      // the loop.
      if (this._lastConnectTime > 0) {
        const connectionDuration = monotonic() - this._lastConnectTime;
        const result = this._quickFailureTracker.record(connectionDuration);
        if (result.isQuickFailure) {
          logger.warning(
            `${this} connection lasted only ${connectionDuration.toFixed(1)}s ` +
              `(${this._quickFailureTracker.count}/` +
              `${this._quickFailureTracker.maxConsecutiveFailures} ` +
              "consecutive quick failures)",
          );
        }
        if (result.shouldGiveUp) {
          const msg =
            `${this} connection failed ` +
            `${this._quickFailureTracker.maxConsecutiveFailures} ` +
            "times immediately after connecting";
          logger.error(msg);
          await reportError(new ErrorFrame({ error: msg }), { forceTreatAsPermanent: true });
          return false;
        }
      }

      // Log the message
      logger.warning(errorMessage);

      // Try to reconnect if enabled
      if (this._reconnectOnError) {
        return await this._tryReconnect({ reportError });
      }
      // `reconnectOnError` governs this loop only: services that turn it off
      // reconnect on demand in `sendWithRetry` instead. Reporting the drop as
      // terminal would close that path too.
      await reportError(new ErrorFrame({ error: errorMessage, exception: error }));
      return false;
    }

    /**
     * Handle messages until the server confirms the connection.
     *
     * For services whose server confirms a connection with a message after
     * the handshake. `handleMessage` sets `confirmed` when that message
     * arrives.
     *
     * @param messages The connection's message iterator, left positioned
     *   after the confirmation for the caller to keep reading.
     * @param confirmed Event set once the server confirms the connection.
     * @param handleMessage Handles one message.
     * @param timeoutS Maximum time, in seconds, to wait for the confirmation.
     * @returns True once confirmed, false if the connection closed first.
     * @throws Error (Python's `ConnectionError`) if the confirmation doesn't
     *   arrive within `timeoutS`.
     */
    async _receiveUntilConfirmed(
      messages: AsyncIterator<WebsocketData>,
      confirmed: Event,
      handleMessage: (message: WebsocketData) => Promise<void>,
      timeoutS: number,
    ): Promise<boolean> {
      try {
        const closed = await timeout(timeoutS, async () => {
          while (!confirmed.isSet()) {
            const next = await messages.next();
            if (next.done) return true;
            await handleMessage(next.value);
          }
          return false;
        });
        if (closed) return false;
      } catch (e) {
        if (e instanceof TimeoutError) {
          // The connection never carried a session, so it counts as failing
          // right after connecting, and the receive loop gives up after a
          // few in a row rather than retrying forever.
          this._lastConnectTime = monotonic();
          throw new Error(`${this} did not confirm the connection within ${timeoutS}s`);
        }
        throw e;
      }
      return true;
    }

    /**
     * Handle websocket message receiving with automatic retry logic.
     *
     * Continuously receives messages with automatic reconnection on errors.
     * Uses exponential backoff between retry attempts and reports fatal
     * errors after maximum retries are exhausted.
     *
     * @param reportError Callback function to report connection errors.
     */
    async _receiveTaskHandler(reportError: ReportErrorCallback): Promise<void> {
      while (true) {
        this._lastConnectTime = monotonic();
        try {
          await this._receiveMessages();
          // _receiveMessages() returned normally. This happens when the
          // websocket closes gracefully (server sent close frame). The
          // `for await` loop over the websocket exits without throwing in
          // this case. We must handle this to avoid an infinite loop.
          const message = `${this} connection closed by server`;
          const shouldContinue = await this._maybeTryReconnect(message, reportError);
          if (!shouldContinue) break;
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          if (e instanceof ConnectionClosedOK) {
            // Normal closure, don't retry
            logger.debug(`${this} connection closed normally: ${e.message}`);
            break;
          }
          let message: string;
          if (e instanceof ConnectionClosedError) {
            // Connection closed with error (e.g., no close frame
            // received/sent). This often indicates network issues, server
            // problems, or abrupt disconnection.
            message = `${this} connection closed, but with an error: ${e.message}`;
          } else {
            // General error during message receiving
            message = `${this} error receiving messages: ${errorText(e)}`;
          }
          const shouldContinue = await this._maybeTryReconnect(message, reportError, e);
          if (!shouldContinue) break;
        }
      }
    }

    /**
     * Connect to the service and reset the disconnecting flag.
     *
     * Manages the disconnecting flag to enable reconnection. Subclasses
     * should call `super._connect()` first, then implement their specific
     * connection logic including websocket connection via
     * `_connectWebsocket()` and any additional setup required.
     */
    async _connect(): Promise<void> {
      this._disconnecting = false;
      this._quickFailureTracker.reset();
    }

    /**
     * Disconnect from the service and set the disconnecting flag.
     *
     * Manages the disconnecting flag to prevent reconnection during
     * intentional disconnect. Subclasses should call `super._disconnect()`
     * first, then implement their specific disconnection logic including
     * websocket disconnection via `_disconnectWebsocket()` and any cleanup
     * required.
     */
    async _disconnect(): Promise<void> {
      this._disconnecting = true;
    }

    /**
     * Establish the websocket connection.
     *
     * Implement the low-level websocket connection logic specific to the
     * service. Should only handle websocket connection, not additional
     * service setup.
     */
    abstract _connectWebsocket(): Promise<void>;

    /**
     * Close the websocket connection.
     *
     * Implement the low-level websocket disconnection logic specific to the
     * service. Should only handle websocket disconnection, not additional
     * service cleanup.
     */
    abstract _disconnectWebsocket(): Promise<void>;

    /**
     * Receive and process websocket messages.
     *
     * Implement service-specific logic for receiving and handling messages
     * from the websocket connection. Called continuously by the receive task
     * handler.
     */
    abstract _receiveMessages(): Promise<void>;
  }
  return WebsocketServiceMixin;
});

/** Python's `f"{e}"` for an exception. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
