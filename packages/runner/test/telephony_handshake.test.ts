// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * `telephonyHandshake`: the provider handshake as a typed outcome, including a
 * caller who hangs up before the handshake completes.
 */

import { describe, expect, test } from "bun:test";

import { TelnyxCallData } from "../src/types.ts";
import {
  parseTelephonyWebsocket,
  type TelephonyWebsocket,
  type TelephonyWebsocketMessage,
  telephonyHandshake,
} from "../src/utils.ts";

/** Hands out `messages` as text, then a disconnect; counts reads. */
class MockWebsocket implements TelephonyWebsocket {
  reads = 0;
  messages: unknown[];

  constructor(messages: unknown[]) {
    this.messages = messages;
  }

  async receive(): Promise<TelephonyWebsocketMessage> {
    const i = this.reads++;
    if (i >= this.messages.length) return { type: "websocket.disconnect" };
    return { type: "websocket.receive", text: JSON.stringify(this.messages[i]) };
  }
}

const TELNYX_CONNECTED = { event: "connected", version: "1.0.0" };
const TELNYX_START = {
  event: "start",
  sequence_number: "1",
  start: {
    user_id: "u-1",
    call_control_id: "v3:cc-123",
    call_session_id: "sess-1",
    from: "+15551234567",
    to: "+15559876543",
    media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
  },
  stream_id: "stream-abc",
};

describe("telephonyHandshake", () => {
  test("Telnyx connected then start: stream id, call control id and call_id", async () => {
    const handshake = await telephonyHandshake(new MockWebsocket([TELNYX_CONNECTED, TELNYX_START]));
    expect(handshake.status).toBe("started");
    if (handshake.status !== "started") return;
    expect(handshake.transportType).toBe("telnyx");
    const callData = handshake.callData as TelnyxCallData;
    expect(callData).toBeInstanceOf(TelnyxCallData);
    expect(callData.streamId).toBe("stream-abc");
    // Telnyx's call control id is the normalized call_id.
    expect(callData.callId).toBe("v3:cc-123");
    expect(callData.getItem("call_id")).toBe("v3:cc-123");
    expect(callData.outboundEncoding).toBe("PCMU");
    expect(callData.fromNumber).toBe("+15551234567");
    expect(callData.toNumber).toBe("+15559876543");
  });

  test("the caller hangs up after Telnyx's connected, before start", async () => {
    const socket = new MockWebsocket([TELNYX_CONNECTED]);
    const handshake = await telephonyHandshake(socket);
    expect(handshake).toEqual({ status: "closed", messagesReceived: 1 });
  });

  test("the socket closes before any message", async () => {
    const handshake = await telephonyHandshake(new MockWebsocket([]));
    expect(handshake).toEqual({ status: "closed", messagesReceived: 0 });
  });

  test("two messages that are no provider's handshake", async () => {
    const handshake = await telephonyHandshake(
      new MockWebsocket([{ event: "connected" }, { hello: "world" }]),
    );
    expect(handshake.status).toBe("unrecognized");
  });

  test("a provider that sends start alone is started, not closed", async () => {
    const handshake = await telephonyHandshake(
      new MockWebsocket([{ event: "start", start: { streamSid: "MZ1", callSid: "CA1" } }]),
    );
    expect(handshake.status).toBe("started");
    if (handshake.status === "started") expect(handshake.callData.callId).toBe("CA1");
  });

  test("shares parseTelephonyWebsocket's cache: the stream is read once", async () => {
    const socket = new MockWebsocket([TELNYX_CONNECTED, TELNYX_START]);
    const [transportType, callData] = await parseTelephonyWebsocket(socket);
    const handshake = await telephonyHandshake(socket);
    expect(socket.reads).toBe(2);
    expect(handshake).toEqual({ status: "started", transportType, callData } as never);
  });

  test("parseTelephonyWebsocket keeps upstream's behavior for an early hang-up", async () => {
    // Upstream logs a warning and returns ("unknown", CallData()) after one message...
    const [transportType, callData] = await parseTelephonyWebsocket(
      new MockWebsocket([TELNYX_CONNECTED]),
    );
    expect(transportType).toBe("unknown");
    expect(callData.callId).toBeNull();
    // ...and raises ValueError with none.
    await expect(parseTelephonyWebsocket(new MockWebsocket([]))).rejects.toThrow(
      "WebSocket closed before receiving",
    );
  });
});
