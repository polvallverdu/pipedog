// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_websocket_client_transport.py

/** Tests for the WebSocket client transport. */

import { expect, mock, test } from "bun:test";
import { gather, sleep } from "@pipedog/asyncio";
import { type Frame, OutputAudioRawFrame } from "@pipedog/core/frames/frames";
import { FrameSerializer, type SerializedData } from "@pipedog/core/serializers/base_serializer";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import {
  WebsocketClientCallbacks,
  WebsocketClientParams,
  WebsocketClientSession,
  WebsocketClientTransport,
} from "../src/client.ts";
import { State, type WebsocketConnection, type WebsocketData } from "../src/socket.ts";

/** A connection that carries no messages and stays open until closed. */
class _FakeWebsocket implements AsyncIterable<WebsocketData>, AsyncIterator<WebsocketData> {
  closed = false;

  [Symbol.asyncIterator](): AsyncIterator<WebsocketData> {
    return this;
  }

  async next(): Promise<IteratorResult<WebsocketData>> {
    await sleep(3600);
    return { done: true, value: undefined };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

type OnConnected = ReturnType<typeof mock<(websocket: WebsocketConnection) => Promise<void>>>;

function _makeSession(): [WebsocketClientSession, _FakeWebsocket[], OnConnected] {
  const opened: _FakeWebsocket[] = [];

  const fakeConnect = async (): Promise<WebsocketConnection> => {
    await sleep(0.01); // the real one dials the server
    const websocket = new _FakeWebsocket();
    opened.push(websocket);
    return websocket as unknown as WebsocketConnection;
  };

  const onConnected: OnConnected = mock(async (_websocket: WebsocketConnection) => {});
  const callbacks = new WebsocketClientCallbacks({
    onConnected,
    onDisconnected: mock(async () => {}),
    onMessage: mock(async () => {}),
  });
  const session = new WebsocketClientSession(
    "ws://example.com",
    new WebsocketClientParams(),
    callbacks,
    "Test",
  );
  // Upstream monkeypatches the module's `websocket_connect`; the port exposes
  // the connect function on the session.
  session._connect = fakeConnect;
  return [session, opened, onConnected];
}

/**
 * The input and output transports share one session, and both connect it.
 *
 * They are set up concurrently, so a socket opened per caller would leave the
 * losing one dialled with nobody reading it, its handler task overwritten.
 */
test("test_concurrent_setup_opens_a_single_websocket", async () => {
  const [session, opened, onConnected] = _makeSession();

  const taskManager = new TaskManager();
  await session.setup(taskManager);
  await session.setup(taskManager);
  await gather(session.connect(), session.connect());

  // `${opened.length} websockets opened, so one goes unread`
  expect(opened.length).toBe(1);
  expect(onConnected).toHaveBeenCalledTimes(1);

  await session.disconnect();
  await session.disconnect();
});

/**
 * Closing on the first disconnect would leave the other transport sending
 * over a closed socket.
 */
test("test_the_websocket_outlives_the_first_transport_to_disconnect", async () => {
  const [session, opened] = _makeSession();

  const taskManager = new TaskManager();
  await session.setup(taskManager);
  await session.setup(taskManager);
  await gather(session.connect(), session.connect());

  await session.disconnect();
  expect(opened[0]!.closed).toBe(false);

  await session.disconnect();
  expect(opened[0]!.closed).toBe(true);
});

/** Emits one coalesced payload every third frame, buffering the two before it. */
class _CoalescingSerializer extends FrameSerializer {
  _seen = 0;

  /** Emit the accumulated block on every third audio frame. */
  async serialize(frame: Frame): Promise<SerializedData | null> {
    if (!(frame instanceof OutputAudioRawFrame)) {
      return null;
    }
    this._seen += 1;
    if (this._seen % 3) {
      return null;
    }
    const audio = frame.audio;
    const out = new Uint8Array(audio.length * 3);
    for (let i = 0; i < 3; i++) out.set(audio, i * audio.length);
    return out;
  }

  /** Unused; only the output transport is exercised here. */
  async deserialize(_data: SerializedData): Promise<Frame | null> {
    return null;
  }
}

/**
 * Tests for issue #5592.
 *
 * A serializer that buffers audio across calls emits no payload on most of
 * them. Those frames have still been written, so pacing follows the frames
 * taken rather than the payloads that go out.
 */
test("test_every_frame_is_paced_when_payloads_are_coalesced", async () => {
  const params = new WebsocketClientParams({
    serializer: new _CoalescingSerializer(),
    audioOutEnabled: true,
  });
  // The test reaches into protected members, as upstream does.
  const output = new WebsocketClientTransport("ws://localhost:1", params).output() as any;
  output._sampleRate = 16000;
  output._writeAudioSleep = mock(async () => {});

  const connection = {
    state: State.OPEN,
    send: mock(async (_data: WebsocketData) => {}),
  };
  output._session._websocket = connection;

  const frame = new OutputAudioRawFrame({
    audio: new Uint8Array(320),
    sampleRate: 16000,
    numChannels: 1,
  });
  const written: boolean[] = [];
  for (let i = 0; i < 9; i++) {
    written.push(await output.writeAudioFrame(frame));
  }

  expect(written).toEqual(Array(9).fill(true));
  expect(output._writeAudioSleep).toHaveBeenCalledTimes(9);
  expect(connection.send).toHaveBeenCalledTimes(3);
});
