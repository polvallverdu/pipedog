// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_service.py

/** Tests for WebsocketService reconnection and lifecycle behavior. */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import * as asyncio from "@pipedog/asyncio";
import { monotonic, TimeoutError } from "@pipedog/asyncio";

import { ErrorFrame } from "../src/frames/frames.ts";
import * as websocketServiceModule from "../src/services/websocket_service.ts";
import {
  ConnectionClosedError,
  ConnectionClosedOK,
  type ReportErrorCallback,
  WebsocketClientConnection,
  type WebsocketConnectOptions,
  type WebsocketData,
  WebsocketService,
  WS_CLOSE_TIMEOUT,
  WS_SEND_TIMEOUT,
} from "../src/services/websocket_service.ts";
import { BaseObject } from "../src/utils/base_object.ts";
import { logger } from "../src/utils/logger.ts";

// Magic value RFC 6455 requires when deriving the handshake accept header.
const _WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The _no_sleep fixture below stubs out sleep for the whole module, so tests
// that need real elapsed time use this reference instead.
const _realSleep = (seconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

/** Minimal concrete implementation for testing. */
class ConcreteWebsocketService extends WebsocketService(BaseObject) {
  _receiveMessagesImpl: (() => Promise<void>) | null = null;

  async _connectWebsocket(): Promise<void> {}

  async _disconnectWebsocket(): Promise<void> {}

  async _receiveMessages(): Promise<void> {
    if (this._receiveMessagesImpl) {
      await this._receiveMessagesImpl();
    }
  }
}

type ReportErrorMock = ReturnType<typeof mock<ReportErrorCallback>>;

let service: ConcreteWebsocketService;
let reportError: ReportErrorMock;

const originalAsyncio = { ...asyncio };
const originalWebsocketServiceModule = { ...websocketServiceModule };

function patchAsyncio(overrides: Partial<typeof asyncio>): void {
  mock.module("@pipedog/asyncio", () => ({ ...originalAsyncio, ...overrides }));
}

beforeEach(() => {
  service = new ConcreteWebsocketService();
  reportError = mock<ReportErrorCallback>(async () => {});
  // _no_sleep: patch sleep to avoid real backoff waits.
  patchAsyncio({ sleep: mock(async (_s: number) => {}) as unknown as typeof asyncio.sleep });
});

afterEach(() => {
  mock.module("@pipedog/asyncio", () => originalAsyncio);
});

// ---------------------------------------------------------------------------
// Receive loop — how each exception type is handled
// ---------------------------------------------------------------------------

test("test_connection_closed_ok_exits_cleanly", async () => {
  // ConnectionClosedOK exits the loop with no error and no reconnection.
  service._receiveMessagesImpl = mock(async () => {
    throw new ConnectionClosedOK(1000, "Normal closure");
  });
  const tryReconnect = mock(async () => true);
  service._tryReconnect = tryReconnect;

  await service._receiveTaskHandler(reportError);

  expect(reportError).not.toHaveBeenCalled();
  expect(tryReconnect).not.toHaveBeenCalled();
});

test("test_connection_closed_error_triggers_reconnect", async () => {
  // ConnectionClosedError triggers reconnection; loop continues after success.
  let callCount = 0;

  service._receiveMessagesImpl = mock(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new ConnectionClosedError(1006, "Abnormal closure");
    }
    service._disconnecting = true;
  });
  const tryReconnect = mock(async () => true);
  service._tryReconnect = tryReconnect;

  await service._receiveTaskHandler(reportError);

  expect(callCount).toEqual(2);
  expect(tryReconnect).toHaveBeenCalledTimes(1);
});

test("test_graceful_server_close_triggers_reconnect", async () => {
  // Normal return from _receiveMessages (server close frame) triggers reconnection.
  let callCount = 0;

  service._receiveMessagesImpl = mock(async () => {
    callCount += 1;
    if (callCount > 1) {
      service._disconnecting = true;
    }
  });
  const tryReconnect = mock(async () => true);
  service._tryReconnect = tryReconnect;

  await service._receiveTaskHandler(reportError);

  expect(callCount).toEqual(2);
  expect(tryReconnect).toHaveBeenCalledTimes(1);
});

test("test_general_exception_triggers_reconnect", async () => {
  // A general exception in _receiveMessages triggers reconnection.
  let callCount = 0;

  service._receiveMessagesImpl = mock(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error("something broke");
    }
    service._disconnecting = true;
  });
  const tryReconnect = mock(async () => true);
  service._tryReconnect = tryReconnect;

  await service._receiveTaskHandler(reportError);

  expect(callCount).toEqual(2);
  expect(tryReconnect).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Exponential backoff — server unreachable
// ---------------------------------------------------------------------------

/** Python's ConnectionError. */
class ConnectionError extends Error {
  override name = "ConnectionError";
}

test("test_reconnect_succeeds_on_later_attempt", async () => {
  // _tryReconnect retries and succeeds on a later attempt.
  const sideEffects: Array<Error | boolean> = [
    new ConnectionError("fail"),
    new ConnectionError("fail"),
    true,
  ];
  const reconnectWebsocket = mock(async (_attempt: number) => {
    const effect = sideEffects.shift();
    if (effect instanceof Error) throw effect;
    return effect as boolean;
  });
  service._reconnectWebsocket = reconnectWebsocket;

  const result = await service._tryReconnect({ reportError });

  expect(result).toBe(true);
  expect(reconnectWebsocket).toHaveBeenCalledTimes(3);
});

test("test_reconnect_exhausted_emits_error", async () => {
  // Exhausting all retries returns False and emits an ErrorFrame.
  const reconnectWebsocket = mock(async (_attempt: number): Promise<boolean> => {
    throw new ConnectionError("Connection refused");
  });
  service._reconnectWebsocket = reconnectWebsocket;

  const result = await service._tryReconnect({ reportError });

  expect(result).toBe(false);
  expect(reconnectWebsocket).toHaveBeenCalledTimes(3);
  const finalError = reportError.mock.calls.at(-1)?.[0];
  expect(finalError).toBeInstanceOf(ErrorFrame);
  expect(finalError?.error).toContain("Connection refused");
});

test("test_reconnect_exhausted_when_connect_does_not_raise", async () => {
  // A non-raising failed connect is treated as a failed reconnect attempt.
  const result = await service._tryReconnect({ reportError });

  expect(result).toBe(false);
  expect(reportError).toHaveBeenCalledTimes(4);
  const finalError = reportError.mock.calls.at(-1)?.[0];
  expect(finalError).toBeInstanceOf(ErrorFrame);
  expect(finalError?.error).toContain("websocket reconnection failed verification");
});

// ---------------------------------------------------------------------------
// Quick failure detection — accept then immediately close
// ---------------------------------------------------------------------------

test("test_quick_failures_emit_error", async () => {
  // Connections failing immediately after establishment emit error after 3 cycles.
  let callCount = 0;

  service._receiveMessagesImpl = mock(async () => {
    callCount += 1;
    throw new ConnectionClosedError(1008, "Invalid API key");
  });
  service._tryReconnect = mock(async () => true);

  await service._receiveTaskHandler(reportError);

  expect(callCount).toEqual(service._quickFailureTracker.maxConsecutiveFailures);
  expect(reportError).toHaveBeenCalledTimes(1);
  const errorFrame = reportError.mock.calls.at(-1)?.[0];
  expect(errorFrame).toBeInstanceOf(ErrorFrame);
  expect(errorFrame?.error).toContain("failed 3 times immediately after connecting");
});

test("test_stable_connection_resets_quick_failure_counter", async () => {
  // A stable connection resets the quick failure counter; needs 3 new failures to trigger.
  let callCount = 0;

  service._receiveMessagesImpl = mock(async () => {
    callCount += 1;
    throw new ConnectionClosedError(1006, "Abnormal closure");
  });
  service._tryReconnect = mock(async () => true);

  const baseTime = 1000.0;
  const timeValues = [
    // Call 1: set _lastConnectTime, check in _maybeTryReconnect (quick) -> count=1
    baseTime,
    baseTime,
    // Call 2: quick -> count=2
    baseTime + 1.0,
    baseTime + 1.0,
    // Call 3: stable (10s elapsed) -> count=0
    baseTime + 2.0,
    baseTime + 12.0,
    // Call 4: quick -> count=1
    baseTime + 13.0,
    baseTime + 13.0,
    // Call 5: quick -> count=2
    baseTime + 14.0,
    baseTime + 14.0,
    // Call 6: quick -> count=3 -> error emitted, loop stops
    baseTime + 15.0,
    baseTime + 15.0,
  ][Symbol.iterator]();

  patchAsyncio({
    sleep: mock(async (_s: number) => {}) as unknown as typeof asyncio.sleep,
    monotonic: () => {
      const next = timeValues.next();
      if (next.done) throw new Error("StopIteration");
      return next.value;
    },
  });
  await service._receiveTaskHandler(reportError);

  expect(callCount).toEqual(6);
  expect(reportError).toHaveBeenCalledTimes(1);
  expect(reportError.mock.calls[0]?.[0]).toBeInstanceOf(ErrorFrame);
});

// ---------------------------------------------------------------------------
// Waiting for the server to confirm a connection
// ---------------------------------------------------------------------------

async function* _messages(
  items: string[],
  options: { thenHang?: boolean } = {},
): AsyncGenerator<string, void, unknown> {
  for (const item of items) {
    yield item;
  }
  if (options.thenHang) {
    await new asyncio.Event().wait();
  }
}

function _confirmOn(
  confirmation: string,
  confirmed: asyncio.Event,
  handled: WebsocketData[],
): (message: WebsocketData) => Promise<void> {
  return async (message) => {
    handled.push(message);
    if (message === confirmation) {
      confirmed.set();
    }
  };
}

test("test_receive_until_confirmed_stops_after_confirmation", async () => {
  // Messages up to the confirmation are handled; the rest are left for the caller.
  const confirmed = new asyncio.Event();
  const handled: WebsocketData[] = [];
  const messages = _messages(["hello", "connected", "after"]);

  const result = await service._receiveUntilConfirmed(
    messages,
    confirmed,
    _confirmOn("connected", confirmed, handled),
    1.0,
  );

  expect(result).toBe(true);
  expect(handled).toEqual(["hello", "connected"]);
  const rest: string[] = [];
  for await (const m of messages) rest.push(m);
  expect(rest).toEqual(["after"]);
});

test("test_receive_until_confirmed_returns_false_when_closed_first", async () => {
  // A connection that closes before confirming returns False.
  const confirmed = new asyncio.Event();
  const handled: WebsocketData[] = [];

  const result = await service._receiveUntilConfirmed(
    _messages(["hello"]),
    confirmed,
    _confirmOn("connected", confirmed, handled),
    1.0,
  );

  expect(result).toBe(false);
  expect(handled).toEqual(["hello"]);
});

test("test_receive_until_confirmed_times_out_as_a_quick_failure", async () => {
  // A missing confirmation raises ConnectionError and restarts the connection's lifetime.
  const confirmed = new asyncio.Event();
  service._lastConnectTime = 0.0;

  await expect(
    service._receiveUntilConfirmed(
      _messages(["hello"], { thenHang: true }),
      confirmed,
      _confirmOn("connected", confirmed, []),
      0.05,
    ),
  ).rejects.toThrow("did not confirm the connection");

  expect(monotonic() - service._lastConnectTime).toBeLessThan(1.0);
});

test("test_receive_until_confirmed_propagates_handler_errors", async () => {
  // An error raised while handling a message reaches the caller.
  const reject = async (_message: WebsocketData): Promise<void> => {
    throw new Error("rejected");
  };

  await expect(
    service._receiveUntilConfirmed(_messages(["error"]), new asyncio.Event(), reject, 1.0),
  ).rejects.toThrow("rejected");
});

// ---------------------------------------------------------------------------
// Lifecycle and guards
// ---------------------------------------------------------------------------

test("test_disconnect_prevents_reconnection", async () => {
  // After _disconnect(), errors exit the loop without reconnecting or emitting errors.
  await service._disconnect();

  service._receiveMessagesImpl = mock(async () => {
    throw new ConnectionClosedError(1006, "Abnormal closure");
  });
  const tryReconnect = mock(async () => true);
  service._tryReconnect = tryReconnect;

  await service._receiveTaskHandler(reportError);

  expect(reportError).not.toHaveBeenCalled();
  expect(tryReconnect).not.toHaveBeenCalled();
});

test("test_connect_resets_state", async () => {
  // _connect() resets _disconnecting and the quick-failure tracker.
  service._disconnecting = true;
  service._quickFailureTracker.count = 5;

  await service._connect();

  expect(service._disconnecting).toBe(false);
  expect(service._quickFailureTracker.count).toEqual(0);
});

// ---------------------------------------------------------------------------
// Close timeout — bounding the closing handshake
// ---------------------------------------------------------------------------

/** connect_mock: patch the underlying websocketConnect() and capture its args. */
function patchConnect() {
  const connectMock = mock(
    async (_uri: string, _options?: WebsocketConnectOptions) =>
      ({}) as unknown as WebsocketClientConnection,
  );
  mock.module("../src/services/websocket_service.ts", () => ({
    ...originalWebsocketServiceModule,
    websocketConnect: connectMock,
  }));
  return connectMock;
}

function restoreConnect(): void {
  mock.module("../src/services/websocket_service.ts", () => originalWebsocketServiceModule);
}

test("test_websocket_connect_applies_default_close_timeout", async () => {
  // Connections get the default close timeout without the caller asking.
  const connectMock = patchConnect();
  try {
    await service._websocketConnect("wss://example.test");

    expect(connectMock.mock.calls.at(-1)?.[1]?.closeTimeout).toEqual(WS_CLOSE_TIMEOUT);
  } finally {
    restoreConnect();
  }
});

test("test_websocket_connect_honors_constructor_override", async () => {
  // wsCloseTimeout passed at construction reaches the connection.
  const connectMock = patchConnect();
  try {
    const service = new ConcreteWebsocketService({ wsCloseTimeout: 7.5 });

    await service._websocketConnect("wss://example.test");

    expect(connectMock.mock.calls.at(-1)?.[1]?.closeTimeout).toEqual(7.5);
  } finally {
    restoreConnect();
  }
});

test("test_websocket_connect_honors_per_call_override", async () => {
  // An explicit closeTimeout wins over the service default.
  //
  // Used by services whose peer never acknowledges the closing handshake.
  const connectMock = patchConnect();
  try {
    await service._websocketConnect("wss://example.test", { closeTimeout: 0 });

    expect(connectMock.mock.calls.at(-1)?.[1]?.closeTimeout).toEqual(0);
  } finally {
    restoreConnect();
  }
});

test("test_websocket_connect_forwards_arguments", async () => {
  // The URI and caller options are passed through untouched.
  const connectMock = patchConnect();
  try {
    const headers = { Authorization: "Bearer token" };

    await service._websocketConnect("wss://example.test", { additionalHeaders: headers });

    const args = connectMock.mock.calls.at(-1);
    expect(args?.[0]).toEqual("wss://example.test");
    expect(args?.[1]?.additionalHeaders).toBe(headers);
  } finally {
    restoreConnect();
  }
});

/**
 * Stand-in for a `WebSocket` whose peer acknowledges a close after
 * `closeDelay` seconds (or never, if null).
 */
class FakeWebSocket extends EventTarget {
  binaryType = "blob";
  readyState: number = WebSocket.OPEN;
  url = "wss://example.test/";
  bufferedAmount = 0;

  constructor(readonly closeDelay: number | null) {
    super();
  }

  send(_data: unknown): void {}

  close(code = 1000, reason = ""): void {
    this.readyState = WebSocket.CLOSING;
    const finish = () => {
      this.readyState = WebSocket.CLOSED;
      const event = new Event("close") as Event & { code: number; reason: string };
      event.code = code;
      event.reason = reason;
      this.dispatchEvent(event);
    };
    if (this.closeDelay === null) return;
    if (this.closeDelay === 0) finish();
    else void _realSleep(this.closeDelay).then(finish);
  }
}

test("test_websocket_connect_installs_bounded_close_connection", async () => {
  // Connections are created as the class that reports an overrunning close.
  //
  // Upstream checks the `create_connection=_BoundedConnection` kwarg
  // passed to `websockets.connect`. Here the bounded close is built into
  // WebsocketClientConnection, which websocketConnect() always returns, so
  // the check is on the returned connection.
  const websocket = await service._websocketConnect("wss://example.test", {
    webSocketFactory: () => new FakeWebSocket(0) as unknown as WebSocket,
  });

  expect(websocket).toBeInstanceOf(WebsocketClientConnection);
});

/** log_sink: capture logger output for the duration of a test. */
function withLogSink(): { getValue(): string; remove(): void } {
  const lines: string[] = [];
  const remove = logger.addSink((record) => {
    lines.push(record.message);
  });
  return { getValue: () => lines.join("\n"), remove };
}

test("test_bounded_close_logs_when_handshake_overruns", async () => {
  // An unacknowledged close is logged so a silent teardown cost leaves a trace.
  const logSink = withLogSink();
  try {
    // The peer takes 0.1s to acknowledge, past the 0.05s close timeout.
    const conn = new WebsocketClientConnection(new FakeWebSocket(0.1) as unknown as WebSocket, {
      closeTimeout: 0.05,
    });

    await conn.close();

    expect(logSink.getValue()).toContain("did not acknowledge the websocket close");
  } finally {
    logSink.remove();
  }
});

test("test_bounded_close_silent_when_handshake_completes", async () => {
  // A clean close logs nothing.
  const logSink = withLogSink();
  try {
    const conn = new WebsocketClientConnection(new FakeWebSocket(0) as unknown as WebSocket, {
      closeTimeout: 5.0,
    });

    await conn.close();

    expect(logSink.getValue()).not.toContain("did not acknowledge the websocket close");
  } finally {
    logSink.remove();
  }
});

// DIVERGENCE: Bun's client `WebSocket` dispatches `close` (code 1000) as soon
// as `close()` is called, without waiting for the peer to acknowledge the
// closing handshake, so on Bun a deaf peer is indistinguishable from a clean
// close: `close()` returns at once and nothing is logged. The bounded-close
// logic itself is covered by the two tests above with a stand-in socket.
test.skip("test_bounded_close_against_unresponsive_peer", async () => {
  // End to end: a peer that never acknowledges the close is bounded and logged.
  //
  // Serves a raw WebSocket handshake and then goes silent, which is the
  // condition that makes the closing handshake overrun.
  const logSink = withLogSink();
  const decoder = new TextDecoder();
  const server = Bun.listen<{ request: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { request: "" };
      },
      data(socket, chunk) {
        if (socket.data.request.includes("\r\n\r\n")) return; // Deaf after the handshake.
        socket.data.request += decoder.decode(chunk);
        if (!socket.data.request.includes("\r\n\r\n")) return;
        const key = socket.data.request
          .split("\r\n")
          .find((line) => line.toLowerCase().startsWith("sec-websocket-key:"))
          ?.split(":", 2)[1]
          ?.trim();
        const accept = new Bun.CryptoHasher("sha1").update(key + _WS_GUID).digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
      },
    },
  });
  const port = server.port;
  const service = new ConcreteWebsocketService({ wsCloseTimeout: 0.3 });
  try {
    const websocket = await service._websocketConnect(`ws://127.0.0.1:${port}`);
    expect(websocket).toBeInstanceOf(WebsocketClientConnection);

    const started = monotonic();
    await websocket.close();
    const elapsed = monotonic() - started;

    // Bounded by wsCloseTimeout rather than the websockets default of 10s,
    // and 1006 confirms the peer never sent its close frame.
    expect(elapsed).toBeGreaterThanOrEqual(0.3);
    expect(elapsed).toBeLessThan(3.0);
    expect(websocket.closeCode).toEqual(1006);
    expect(logSink.getValue()).toContain("did not acknowledge the websocket close");
  } finally {
    logSink.remove();
    server.stop(true);
  }
});

// ---------------------------------------------------------------------------
// Send timeout — bounding a send to a peer that has stopped reading
// ---------------------------------------------------------------------------

test("test_websocket_connect_applies_default_send_timeout", async () => {
  // Connections get the default send timeout without the caller asking.
  const connectMock = patchConnect();
  try {
    connectMock.mockResolvedValue(
      new WebsocketClientConnection(new FakeWebSocket(0) as unknown as WebSocket),
    );

    const websocket = await service._websocketConnect("wss://example.test");

    expect(websocket.sendTimeout).toEqual(WS_SEND_TIMEOUT);
  } finally {
    restoreConnect();
  }
});

// @pytest.mark.parametrize("timeout", [3.5, None])
test.each([[3.5], [null]])(
  "test_websocket_connect_honors_send_timeout_override[%p]",
  async (timeout: number | null) => {
    // wsSendTimeout passed at construction reaches the connection.
    const connectMock = patchConnect();
    try {
      const service = new ConcreteWebsocketService({ wsSendTimeout: timeout });
      connectMock.mockResolvedValue(
        new WebsocketClientConnection(new FakeWebSocket(0) as unknown as WebSocket),
      );

      const websocket = await service._websocketConnect("wss://example.test");

      expect(websocket.sendTimeout).toEqual(timeout);
    } finally {
      restoreConnect();
    }
  },
);

test("test_bounded_send_passes_through_without_timeout", async () => {
  // With no send timeout the send is awaited unchanged.
  const ws = new FakeWebSocket(0);
  const sent = mock((_data: unknown) => {});
  ws.send = sent;
  const conn = new WebsocketClientConnection(ws as unknown as WebSocket);
  const audio = new TextEncoder().encode("audio");

  await conn.send(audio);

  expect(sent).toHaveBeenCalledTimes(1);
  expect(sent).toHaveBeenCalledWith(audio);
});

test("test_bounded_send_aborts_transport_when_send_stalls", async () => {
  // A send that outlasts the timeout drops the connection and fails as closed.
  //
  // The `WebSocket` API never blocks a send, so a stalled send is a write
  // buffer that never drains; dropping the transport is closing the socket.
  const logSink = withLogSink();
  try {
    const ws = new FakeWebSocket(null);
    ws.url = "wss://stt.example.test/";
    ws.send = () => {
      ws.bufferedAmount = 10 * 1024 * 1024;
    };
    const abort = mock(() => {});
    ws.close = abort;
    const conn = new WebsocketClientConnection(ws as unknown as WebSocket, {
      sendTimeout: 0.05,
    });

    await expect(conn.send(new TextEncoder().encode("audio"))).rejects.toThrow(
      ConnectionClosedError,
    );

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith();
    expect(logSink.getValue()).toContain("send to stt.example.test did not complete");
  } finally {
    logSink.remove();
  }
});

test("test_bounded_send_leaves_other_timeouts_alone", async () => {
  // A TimeoutError raised by the send itself is not mistaken for the bound expiring.
  const ws = new FakeWebSocket(null);
  ws.send = () => {
    throw new TimeoutError("inner");
  };
  const abort = mock(() => {});
  ws.close = abort;
  const conn = new WebsocketClientConnection(ws as unknown as WebSocket, { sendTimeout: 5.0 });

  await expect(conn.send(new TextEncoder().encode("audio"))).rejects.toThrow(
    new TimeoutError("inner"),
  );

  expect(abort).not.toHaveBeenCalled();
});

test("test_bounded_send_against_peer_that_stops_reading", async () => {
  // End to end: a send that cannot drain is bounded and closes the connection.
  //
  // Upstream pauses writes on the connection, which is what the transport does
  // once a peer stops reading and the write buffer fills. The `WebSocket` API
  // has no such hook, so here the peer really stops reading after the
  // handshake and a send larger than the socket buffers fills them.
  const decoder = new TextDecoder();
  const server = Bun.listen<{ request: string; deaf: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { request: "", deaf: false };
      },
      data(socket, chunk) {
        if (socket.data.deaf) return;
        socket.data.request += decoder.decode(chunk);
        if (!socket.data.request.includes("\r\n\r\n")) return;
        socket.data.deaf = true;
        const key = socket.data.request
          .split("\r\n")
          .find((line) => line.toLowerCase().startsWith("sec-websocket-key:"))
          ?.split(":", 2)[1]
          ?.trim();
        const accept = new Bun.CryptoHasher("sha1").update(key + _WS_GUID).digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        // Stop reading: what is sent now stays in the socket buffers.
        socket.pause();
      },
    },
  });
  const port = server.port;
  const service = new ConcreteWebsocketService({ wsSendTimeout: 0.3, wsCloseTimeout: 0.1 });
  try {
    const websocket = await service._websocketConnect(`ws://127.0.0.1:${port}`);

    const started = monotonic();
    await expect(websocket.send(new Uint8Array(64 * 1024 * 1024))).rejects.toThrow(
      ConnectionClosedError,
    );
    const elapsed = monotonic() - started;

    expect(elapsed).toBeGreaterThanOrEqual(0.3);
    expect(elapsed).toBeLessThan(3.0);
    expect(websocket.closeCode).toEqual(1006);
  } finally {
    server.stop(true);
  }
});
