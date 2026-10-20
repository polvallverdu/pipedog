// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_fastapi_websocket.py

import { describe, expect, mock, test } from "bun:test";

import {
  CancelledError,
  createTask,
  Event,
  monotonic,
  rethrowIfCancelled,
  sleep,
  type Task,
  waitFor,
} from "@pipedog/asyncio";
import { type Frame, OutputAudioRawFrame } from "@pipedog/core/frames/frames";
import { FrameSerializer } from "@pipedog/core/serializers/base_serializer";
import { LOG_LEVELS, type LogLevel, logger } from "@pipedog/core/utils/logger";

import {
  _WebSocketMessageIterator,
  type FastAPIWebSocket,
  FastAPIWebsocketCallbacks,
  FastAPIWebsocketClient,
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "../src/fastapi.ts";
import { WebSocketState, type WebsocketReceiveMessage } from "../src/socket.ts";

type Any = any;

/**
 * Stand-in for `AsyncMock()` used as a Starlette `WebSocket`: every method is
 * an async mock, and the two state properties are getters (`PropertyMock`).
 */
function makeMockWs(
  options: { clientState?: () => WebSocketState; applicationState?: () => WebSocketState } = {},
): FastAPIWebSocket & Any {
  const ws: Any = {
    headers: { get: (_: string) => null },
    receive: mock(async (): Promise<WebsocketReceiveMessage> => ({ type: "websocket.disconnect" })),
    sendBytes: mock(async (_data: Uint8Array) => {}),
    sendText: mock(async (_data: string) => {}),
    close: mock(async () => {}),
  };
  Object.defineProperty(ws, "clientState", {
    get: options.clientState ?? (() => WebSocketState.CONNECTED),
  });
  Object.defineProperty(ws, "applicationState", {
    get: options.applicationState ?? (() => WebSocketState.CONNECTED),
  });
  return ws;
}

/** `receive.side_effect = [...]`: return each message in turn. */
function receiveSideEffect(messages: WebsocketReceiveMessage[]) {
  const queue = [...messages];
  return mock(async () => {
    const next = queue.shift();
    if (!next) throw new Error("StopAsyncIteration");
    return next;
  });
}

async function collect(iterator: AsyncIterable<Uint8Array | string>) {
  const messages: (Uint8Array | string)[] = [];
  for await (const msg of iterator) messages.push(msg);
  return messages;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("TestWebSocketMessageIterator", () => {
  test("test_yields_binary_message", async () => {
    const mockWebsocket = makeMockWs();
    mockWebsocket.receive = receiveSideEffect([
      { type: "websocket.receive", bytes: enc("binary data"), text: null },
      { type: "websocket.disconnect" },
    ]);

    const iterator = new _WebSocketMessageIterator(mockWebsocket);
    const messages = await collect(iterator);

    expect(messages.length).toEqual(1);
    expect(messages[0]).toEqual(enc("binary data"));
  });

  test("test_yields_text_message", async () => {
    const mockWebsocket = makeMockWs();
    mockWebsocket.receive = receiveSideEffect([
      { type: "websocket.receive", bytes: null, text: "text data" },
      { type: "websocket.disconnect" },
    ]);

    const iterator = new _WebSocketMessageIterator(mockWebsocket);
    const messages = await collect(iterator);

    expect(messages.length).toEqual(1);
    expect(messages[0]).toEqual("text data");
  });

  test("test_yields_mixed_messages", async () => {
    const mockWebsocket = makeMockWs();
    mockWebsocket.receive = receiveSideEffect([
      { type: "websocket.receive", bytes: enc("binary"), text: null },
      { type: "websocket.receive", bytes: null, text: "text" },
      { type: "websocket.receive", bytes: enc("more binary"), text: null },
      { type: "websocket.disconnect" },
    ]);

    const iterator = new _WebSocketMessageIterator(mockWebsocket);
    const messages = await collect(iterator);

    expect(messages.length).toEqual(3);
    expect(messages[0]).toEqual(enc("binary"));
    expect(messages[1]).toEqual("text");
    expect(messages[2]).toEqual(enc("more binary"));
  });

  test("test_stops_on_disconnect", async () => {
    const mockWebsocket = makeMockWs();
    mockWebsocket.receive = receiveSideEffect([{ type: "websocket.disconnect" }]);

    const iterator = new _WebSocketMessageIterator(mockWebsocket);
    const messages = await collect(iterator);

    expect(messages.length).toEqual(0);
  });
});

function makeCallbacks() {
  return new FastAPIWebsocketCallbacks({
    onClientConnected: mock(async () => {}),
    onClientDisconnected: mock(async () => {}),
    onSessionTimeout: mock(async () => {}),
  });
}

/**
 * Tests for the race condition in issue #3912.
 *
 * When the remote side disconnects while send() is in flight, send() should
 * not set _closing = True, because that flag means "we initiated the close."
 * Setting it from send() prevents the receive loop from firing
 * on_client_disconnected, which can cause the pipeline to hang.
 */
describe("TestSendDisconnectRace", () => {
  function _makeClient(mockWs: FastAPIWebSocket) {
    const callbacks = makeCallbacks();
    const client = new FastAPIWebsocketClient(mockWs, callbacks);
    return { client, callbacks };
  }

  test("test_send_disconnect_does_not_set_closing", async () => {
    // send() should not set _closing when the remote side disconnects.
    const mockWs = makeMockWs({
      clientState: () => WebSocketState.CONNECTED,
      applicationState: () => WebSocketState.DISCONNECTED,
    });
    mockWs.sendBytes = mock(async () => {
      throw new Error("connection closed");
    });

    const { client } = _makeClient(mockWs);

    await client.send(enc("audio data"));

    expect(client.isClosing).toBe(false);
  });

  test("test_send_suppressed_after_disconnect", async () => {
    // After a failed send, _can_send() returns False via application_state.
    //
    // Simulates real Starlette behavior: application_state starts CONNECTED,
    // transitions to DISCONNECTED when send_bytes raises (Starlette does this
    // internally on OSError before re-raising as WebSocketDisconnect).

    // application_state transitions from CONNECTED → DISCONNECTED on send failure
    const appState: { state: WebSocketState } = { state: WebSocketState.CONNECTED };
    const mockWs = makeMockWs({
      clientState: () => WebSocketState.CONNECTED,
      applicationState: () => appState.state,
    });

    mockWs.sendBytes = mock(async (_data: Uint8Array) => {
      appState.state = WebSocketState.DISCONNECTED;
      throw new Error("connection closed");
    });

    const { client } = _makeClient(mockWs);

    // First send: _can_send() passes (app_state CONNECTED), send_bytes raises,
    // Starlette sets app_state to DISCONNECTED
    await client.send(enc("audio data"));
    // Second send: _can_send() returns False (app_state now DISCONNECTED)
    await client.send(enc("more audio"));

    // send_bytes was only called once (the first attempt)
    expect(mockWs.sendBytes).toHaveBeenCalledTimes(1);
  });

  test("test_disconnect_callback_fires_when_send_races_receive", async () => {
    // Regression test for issue #3912.
    //
    // The receive loop is blocked waiting for the next message. Meanwhile,
    // send() is called and hits an exception because the remote side closed.
    // Then the receive loop unblocks and sees the disconnect.
    //
    // on_client_disconnected must still fire, because the remote side
    // initiated the close — not us.
    const sendDone = new Event();

    const mockWs = makeMockWs({
      clientState: () => WebSocketState.CONNECTED,
      applicationState: () => WebSocketState.DISCONNECTED,
    });
    mockWs.sendBytes = mock(async () => {
      throw new Error("connection closed");
    });

    // receive() blocks until send has completed, then returns disconnect.
    // This enforces the exact ordering that causes the bug.
    mockWs.receive = async (): Promise<WebsocketReceiveMessage> => {
      await sendDone.wait();
      return { type: "websocket.disconnect" };
    };

    const { client, callbacks } = _makeClient(mockWs);

    // Simulate the _receive_messages logic from FastAPIWebsocketInputTransport
    const receiveLoop = async () => {
      try {
        for await (const _ of new _WebSocketMessageIterator(mockWs)) {
          // pass
        }
      } catch (e) {
        rethrowIfCancelled(e);
      }
      if (!client.isClosing) {
        await client.triggerClientDisconnected();
      }
    };

    const recvTask = createTask(() => receiveLoop());

    // Let the receive loop start and block on receive()
    await sleep(0);

    // send() races — hits exception but does NOT set _closing
    await client.send(enc("audio data"));
    expect(client.isClosing).toBe(false);

    // Unblock the receive loop — it sees the disconnect
    sendDone.set();
    await recvTask;

    // The callback fires because _closing was not poisoned by send()
    expect(callbacks.onClientDisconnected).toHaveBeenCalledTimes(1);
  });

  test("test_send_text_disconnect_does_not_set_closing", async () => {
    // Same as test_send_disconnect_does_not_set_closing but with text data.
    const mockWs = makeMockWs({
      clientState: () => WebSocketState.CONNECTED,
      applicationState: () => WebSocketState.DISCONNECTED,
    });
    mockWs.sendText = mock(async () => {
      throw new Error("connection closed");
    });

    const { client } = _makeClient(mockWs);

    await client.send("text data");

    expect(client.isClosing).toBe(false);
  });
});

/**
 * Tests for issue #4528.
 *
 * `disconnect()` must not block indefinitely on a half-closed peer that
 * never acknowledges the WebSocket close handshake (e.g. a telephony call
 * already torn down on the provider's side). The close should be bounded by
 * `ws_close_timeout` so pipeline shutdown can proceed.
 */
describe("TestDisconnectCloseTimeout", () => {
  function _makeClient(mockWs: FastAPIWebSocket, wsCloseTimeout = 0.5) {
    const callbacks = makeCallbacks();
    const client: Any = new FastAPIWebsocketClient(mockWs, callbacks, wsCloseTimeout);
    // setup() bumps the leave counter to 1; disconnect() decrements to 0
    // and then performs the close.
    client._leaveCounter = 1;
    return { client, callbacks };
  }

  /** Capture logger output (pipecat uses loguru, not stdlib logging). */
  async function _captureLogs(
    level: LogLevel,
    fn: (sink: { getValue(): string }) => Promise<void>,
  ): Promise<string> {
    const lines: string[] = [];
    const remove = logger.addSink((record) => {
      if (LOG_LEVELS[record.level] >= LOG_LEVELS[level]) lines.push(record.message);
    });
    const sink = { getValue: () => lines.join("\n") };
    try {
      await fn(sink);
    } finally {
      remove();
    }
    return sink.getValue();
  }

  test("test_disconnect_bounded_when_close_hangs", async () => {
    // disconnect() returns within ws_close_timeout if close() never completes.
    const never = new Event();

    const hangingClose = async () => {
      await never.wait(); // peer never ACKs the close handshake
    };

    const mockWs = makeMockWs({ clientState: () => WebSocketState.CONNECTED });
    mockWs.close = hangingClose;

    const { client } = _makeClient(mockWs, 0.1);

    const start = monotonic();
    const logs = await _captureLogs("DEBUG", async () => {
      // wait_for is the regression guard: against the old unbounded code
      // disconnect() never returns, so this fails fast with TimeoutError
      // instead of hanging CI on the ~10s ASGI close-handshake timeout.
      await waitFor(() => client.disconnect(), 5.0);
    });
    const elapsed = monotonic() - start;

    expect(elapsed).toBeLessThan(2.0);
    expect(client.isClosing).toBe(true);
    expect(logs).toContain("WebSocket close exceeded");

    // The close task outlives the timeout; cancel it to clean up.
    const closeTask = client._closeTask as Task<void>;
    closeTask.cancel();
    try {
      await closeTask;
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
    }
  });

  test("test_disconnect_completes_when_close_succeeds", async () => {
    // Happy path: a peer that ACKs the close lets disconnect() finish fast.
    const mockWs = makeMockWs({ clientState: () => WebSocketState.CONNECTED });
    mockWs.close = mock(async () => {});

    const { client } = _makeClient(mockWs, 5.0);

    await client.disconnect();
    await sleep(0); // let the done callback run

    expect(mockWs.close).toHaveBeenCalledTimes(1);
    expect(client.isClosing).toBe(true);
    expect((client._closeTask as Task<void>).done()).toBe(true);
  });

  test("test_disconnect_noop_when_other_holders_remain", async () => {
    // disconnect() only closes once the last holder leaves.
    const mockWs = makeMockWs({ clientState: () => WebSocketState.CONNECTED });
    mockWs.close = mock(async () => {});

    const { client } = _makeClient(mockWs);
    client._leaveCounter = 2; // input + output both hold the client

    await client.disconnect(); // one leaves; one holder remains

    expect(mockWs.close).not.toHaveBeenCalled();
    expect(client.isClosing).toBe(false);
  });

  test("test_close_error_is_logged_not_raised", async () => {
    // An exception from close() is swallowed (logged), not propagated.
    class RuntimeError extends Error {}
    const mockWs = makeMockWs({ clientState: () => WebSocketState.CONNECTED });
    mockWs.close = mock(async () => {
      throw new RuntimeError("already closed");
    });

    const { client } = _makeClient(mockWs, 5.0);

    const logs = await _captureLogs("ERROR", async () => {
      await client.disconnect(); // must not raise
      // The done callback runs via call_soon (not synchronously), so yield
      // once to let it consume and log the exception before we assert.
      await sleep(0);
    });

    const closeTask = client._closeTask as Task<void>;
    expect(closeTask.done()).toBe(true);
    expect(closeTask.exception()).toBeInstanceOf(RuntimeError);
    expect(logs).toContain("exception while closing the websocket");
  });

  test("test_transport_passes_ws_close_timeout_to_client", async () => {
    // The transport wires params.ws_close_timeout through to its client.
    const mockWs = makeMockWs();
    const params = new FastAPIWebsocketParams({ wsCloseTimeout: 1.25 });

    const transport: Any = new FastAPIWebsocketTransport(mockWs, params);

    expect(transport._client._wsCloseTimeout).toEqual(1.25);
  });
});

/** Emits one coalesced payload every third frame, buffering the two before it. */
class _CoalescingSerializer extends FrameSerializer {
  _seen = 0;

  /** Emit the accumulated block on every third frame. */
  async serialize(_frame: Frame): Promise<string | Uint8Array | null> {
    this._seen += 1;
    if (this._seen % 3) {
      return null;
    }
    return new Uint8Array(960);
  }

  /** Unused; only the output transport is exercised here. */
  async deserialize(_data: string | Uint8Array): Promise<Frame | null> {
    return null;
  }
}

/**
 * Tests for issue #5592.
 *
 * The telephony serializers resample through a stream resampler, which buffers
 * audio across calls: most calls emit no payload and a later one emits a larger
 * block. Those frames have still been written, so pacing follows the frames
 * taken rather than the payloads that go out, and the frames have to keep
 * reaching downstream consumers.
 */
describe("TestWriteAudioFramePacesWrittenFrames", () => {
  function _makeOutput(serializer: FrameSerializer) {
    const mockWs = makeMockWs({
      clientState: () => WebSocketState.CONNECTED,
      applicationState: () => WebSocketState.CONNECTED,
    });

    const params = new FastAPIWebsocketParams({ audioOutEnabled: true, serializer });
    const output: Any = new FastAPIWebsocketTransport(mockWs, params).output();
    output._sampleRate = 8000;
    output._writeAudioSleep = mock(async () => {});
    return { output, mockWs };
  }

  function _audioFrame() {
    return new OutputAudioRawFrame({
      audio: new Uint8Array(320),
      sampleRate: 8000,
      numChannels: 1,
    });
  }

  test("test_every_frame_is_paced_when_payloads_are_coalesced", async () => {
    // Pacing follows the frames taken, not the payloads that go out.
    const { output, mockWs } = _makeOutput(new _CoalescingSerializer());

    const written: boolean[] = [];
    for (let i = 0; i < 9; i++) written.push(await output.writeAudioFrame(_audioFrame()));

    expect(written).toEqual(Array(9).fill(true));
    expect(output._writeAudioSleep).toHaveBeenCalledTimes(9);
    expect(mockWs.sendBytes).toHaveBeenCalledTimes(3);
  });

  test("test_frame_is_not_written_when_serializing_fails", async () => {
    // A serializer that raises leaves the frame unwritten, and unpaced.
    const serializer = new _CoalescingSerializer();
    serializer.serialize = mock(async () => {
      throw new Error("cannot serialize");
    });
    const { output } = _makeOutput(serializer);

    const written = await output.writeAudioFrame(_audioFrame());

    expect(written).toBe(false);
    expect(output._writeAudioSleep).not.toHaveBeenCalled();
  });
});
