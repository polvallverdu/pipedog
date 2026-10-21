// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_runner_utils.py

/**
 * Upstream's runner utils tests: `CallData`, `parse_telephony_websocket` and
 * `create_transport`, plus pipedog's tests of `createTransport` (hang-ups,
 * unported transports) and the SDP munging. The Daily dial-in tests need the
 * Daily transport, which is not ported, and are `todo`.
 *
 * Upstream mocks the socket with `MagicMock().iter_text.return_value =
 * MockAsyncIterator([...])`; here the socket is a stand-in with Starlette's
 * `receive()`, which `parseTelephonyWebsocket` reads.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { EvalFastAPIWebsocketTransport } from "@pipedog/evals/fastapi_transport";
import { EvalConnectionFlags, EvalSerializer, evalConnectMessage } from "@pipedog/evals/serializer";
import { EvalTransportParams } from "@pipedog/evals/transport";
import { TelnyxFrameSerializer } from "@pipedog/serializer-telnyx/telnyx";
import { TwilioFrameSerializer } from "@pipedog/serializer-twilio/twilio";
import { LiveKitParams, LiveKitTransport } from "@pipedog/transport-livekit/transport";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { WebsocketConnection } from "@pipedog/transport-websocket/socket";

import {
  CallData,
  DailyRunnerArguments,
  ExotelCallData,
  LiveKitRunnerArguments,
  MOQRunnerArguments,
  RunnerArguments,
  TelnyxCallData,
  VonageRunnerArguments,
  WebSocketRunnerArguments,
} from "../src/types.ts";
import {
  createTransport,
  parseTelephonyWebsocket,
  smallwebrtcSdpMunging,
  TelephonyCallEndedError,
  TelephonyHandshakeError,
  type TelephonyWebsocket,
  type TelephonyWebsocketMessage,
  TransportNotPortedError,
} from "../src/utils.ts";

/** Mock WebSocket: hands out `messages` as text, then a disconnect. */
class MockWebsocket implements TelephonyWebsocket {
  messages: string[];
  index = 0;

  constructor(messages: string[]) {
    this.messages = messages;
  }

  async receive(): Promise<TelephonyWebsocketMessage> {
    if (this.index >= this.messages.length) {
      return { type: "websocket.disconnect" };
    }
    const message = this.messages[this.index] as string;
    this.index += 1;
    return { type: "websocket.receive", text: message };
  }
}

describe("TestCallData", () => {
  // CallData gives typed attribute access while staying dict-compatible.

  test("test_attribute_access_with_alias", () => {
    const cd = CallData.modelValidate({
      stream_id: "MZ1",
      call_id: "CA1",
      from: "+1555",
      to: "+1666",
    });
    // Wire keys "from"/"to" map onto fromNumber/toNumber (no keyword clash).
    expect(cd.fromNumber).toEqual("+1555");
    expect(cd.toNumber).toEqual("+1666");
    expect(cd.callId).toEqual("CA1");
  });

  test("test_dict_compat_access", () => {
    const cd = CallData.modelValidate({ stream_id: "MZ1", from: "+1555" });
    // Subscript / get / in use the original wire keys.
    expect(cd.getItem("from")).toEqual("+1555");
    expect(cd.getItem("stream_id")).toEqual("MZ1");
    expect(cd.get("from")).toEqual("+1555");
    expect(cd.get("to", "n/a")).toEqual("n/a"); // unset -> default
    expect(cd.has("from")).toBe(true);
    expect(cd.has("to")).toBe(false); // unset fields aren't "in"
  });

  test("test_unset_fields_are_none", () => {
    const cd = CallData.modelValidate({ call_id: "CA1" });
    expect(cd.toNumber).toBeNull();
    expect(cd.body).toEqual({});
  });

  test("test_extra_provider_keys_preserved", () => {
    const cd = CallData.modelValidate({ call_id: "CA1", weird_provider_field: "x" });
    // extra="allow": unmodeled keys remain reachable via dict access.
    expect(cd.getItem("weird_provider_field")).toEqual("x");
  });

  /**
   * callData lives on the base, so any runnerArgs exposes it (defaults null),
   * letting bots read runnerArgs.callData uniformly.
   */
  test("test_call_data_is_a_base_field", () => {
    expect(new RunnerArguments().callData).toBeNull();
    expect(
      new DailyRunnerArguments({ roomUrl: "https://example.daily.co/room" }).callData,
    ).toBeNull();
  });
});

describe("TestParseTelephonyWebSocket", () => {
  test("test_no_messages_raises_value_error", async () => {
    // Test that no messages raises ValueError.
    const mockWebsocket = new MockWebsocket([]);

    await expect(parseTelephonyWebsocket(mockWebsocket)).rejects.toThrow(
      "WebSocket closed before receiving",
    );
  });

  test("test_one_message_logs_warning_and_continues", async () => {
    // Test that one message logs warning but continues processing.
    const twilioMessage = JSON.stringify({
      event: "start",
      start: {
        streamSid: "MZ123",
        callSid: "CA123",
        customParameters: { user_id: "test_user" },
      },
    });

    const mockWebsocket = new MockWebsocket([twilioMessage]);

    const [transportType, callData] = await parseTelephonyWebsocket(mockWebsocket);

    expect(transportType).toEqual("twilio");
    expect(callData.getItem("stream_id")).toEqual("MZ123");
    expect(callData.getItem("call_id")).toEqual("CA123");
  });

  test("test_two_messages_normal_operation", async () => {
    // Test normal operation with two messages.
    const firstMessage = JSON.stringify({ event: "connected" });
    const twilioMessage = JSON.stringify({
      event: "start",
      start: { streamSid: "MZ456", callSid: "CA456", customParameters: {} },
    });

    const mockWebsocket = new MockWebsocket([firstMessage, twilioMessage]);

    const [transportType, callData] = await parseTelephonyWebsocket(mockWebsocket);

    expect(transportType).toEqual("twilio");
    expect(callData.getItem("stream_id")).toEqual("MZ456");
    expect(callData.getItem("call_id")).toEqual("CA456");
  });

  test("test_twilio_promotes_from_to_custom_params", async () => {
    // Twilio from/to TwiML stream params are promoted for a uniform typed API.
    const twilioMessage = JSON.stringify({
      event: "start",
      start: {
        streamSid: "MZ789",
        callSid: "CA789",
        customParameters: { from_number: "+1555", to_number: "+1666" },
      },
    });
    const mockWebsocket = new MockWebsocket([twilioMessage]);

    const [transportType, callData] = await parseTelephonyWebsocket(mockWebsocket);

    expect(transportType).toEqual("twilio");
    expect(callData.fromNumber).toEqual("+1555");
    expect(callData.toNumber).toEqual("+1666");
    // Raw custom params still available under body.
    expect(callData.body.to_number).toEqual("+1666");
  });

  test("test_telnyx_detection", async () => {
    // Test Telnyx provider detection.
    const telnyxMessage = JSON.stringify({
      stream_id: "stream_123",
      start: {
        call_control_id: "cc_123",
        media_format: { encoding: "PCMU" },
        from: "+15551234567",
        to: "+15559876543",
      },
    });

    const mockWebsocket = new MockWebsocket([telnyxMessage]);

    const [transportType, callData] = await parseTelephonyWebsocket(mockWebsocket);

    expect(transportType).toEqual("telnyx");
    expect(callData).toBeInstanceOf(TelnyxCallData);
    expect(callData.getItem("stream_id")).toEqual("stream_123");
    // Telnyx's call_control_id is normalized onto the common call_id field.
    expect(callData.getItem("call_id")).toEqual("cc_123");
    // Provider-specific field is typed on the subclass.
    expect((callData as TelnyxCallData).outboundEncoding).toEqual("PCMU");
  });

  test("test_plivo_detection", async () => {
    // Test Plivo provider detection.
    const plivoMessage = JSON.stringify({
      start: { streamId: "stream_plivo_123", callId: "call_plivo_123" },
    });

    const mockWebsocket = new MockWebsocket([plivoMessage]);

    const [transportType, callData] = await parseTelephonyWebsocket(mockWebsocket);

    expect(transportType).toEqual("plivo");
    expect(callData.getItem("stream_id")).toEqual("stream_plivo_123");
    expect(callData.getItem("call_id")).toEqual("call_plivo_123");
  });

  test("test_exotel_detection", async () => {
    // Test Exotel provider detection.
    const exotelMessage = JSON.stringify({
      event: "start",
      start: {
        stream_sid: "stream_exo_123",
        call_sid: "call_exo_123",
        account_sid: "acc_123",
        from: "+15551111111",
        to: "+15552222222",
      },
    });

    const mockWebsocket = new MockWebsocket([exotelMessage]);

    const [transportType, callData] = await parseTelephonyWebsocket(mockWebsocket);

    expect(transportType).toEqual("exotel");
    expect(callData).toBeInstanceOf(ExotelCallData);
    expect(callData.getItem("stream_id")).toEqual("stream_exo_123");
    expect(callData.getItem("call_id")).toEqual("call_exo_123");
    expect(callData.getItem("account_sid")).toEqual("acc_123");
  });
});

describe("TestParseTelephonyIdempotent", () => {
  test("test_second_call_returns_cached_parse", async () => {
    // The single-use stream is consumed once; a second call returns the cache.
    const twilioMessage = JSON.stringify({
      event: "start",
      start: { streamSid: "MZ1", callSid: "CA1" },
    });
    // One iterator, exhausted after the first parse. A second *real* parse would
    // raise ValueError ("closed before receiving"); the cache must prevent that.
    const ws = new MockWebsocket([twilioMessage]);

    const first = await parseTelephonyWebsocket(ws);
    const second = await parseTelephonyWebsocket(ws);

    expect(first).toEqual(second);
    expect(first[0]).toEqual("twilio");
    expect(first[1].getItem("call_id")).toEqual("CA1");
  });
});

describe("TestParseEvalConnect", () => {
  test("test_eval_connect_detected_from_first_message", async () => {
    const flags = new EvalConnectionFlags({ skipTts: true, captureBotAudio: true });
    const ws = new MockWebsocket([evalConnectMessage(flags)]);

    const [transportType, callData] = await parseTelephonyWebsocket(ws);

    expect(transportType).toEqual("eval");
    expect(EvalConnectionFlags.modelValidate(callData.body)).toEqual(flags);
  });

  test("test_eval_connect_leaves_the_next_message_unread", async () => {
    // The harness's client-ready follows eval-connect and must reach the bot.
    const messages = new MockWebsocket([
      evalConnectMessage(new EvalConnectionFlags()),
      JSON.stringify({ type: "client-ready" }),
    ]);

    await parseTelephonyWebsocket(messages);

    expect(messages.index).toEqual(1);
  });
});

// The serializers hang up through the providers' REST APIs and refuse to start
// without credentials; createTransport reads them from the environment.
const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TELNYX_API_KEY = "test-key";
});
afterAll(() => {
  for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TELNYX_API_KEY"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A WebsocketConnection that has already received `messages`, then closes if `close`. */
function connectionWith(messages: unknown[], close = false): WebsocketConnection {
  const sent: unknown[] = [];
  const connection = new WebsocketConnection({
    send: (data) => {
      sent.push(data);
    },
    close: () => connection.feedClose(1000, ""),
  });
  for (const m of messages) connection.feedMessage(JSON.stringify(m));
  if (close) connection.feedClose(1000, "");
  return connection;
}

describe("TestCreateTransportExposesCallData", () => {
  // DIVERGENCE: upstream patches _create_telephony_transport; ES modules can't be
  // patched, so the real transport is built (a stronger check).
  test("test_telephony_call_data_set_on_runner_args", async () => {
    const ws = connectionWith(
      [{ event: "start", start: { streamSid: "MZ9", callSid: "CA9" } }],
      true,
    );
    const args = new WebSocketRunnerArguments({ websocket: ws }); // transportType null -> telephony

    const result = await createTransport(args, {
      twilio: () => new FastAPIWebsocketParams({ allowedOrigins: [] }),
    });

    expect(result).toBeInstanceOf(FastAPIWebsocketTransport);
    expect((result as any)._params.serializer).toBeInstanceOf(TwilioFrameSerializer);
    expect(args.transportType).toBe("twilio");
    expect(args.callData).not.toBeNull();
    // Both styles work: typed attribute access and dict-style subscript.
    expect(args.callData!.callId).toBe("CA9");
    expect(args.callData!.getItem("call_id")).toBe("CA9");
  });
});

describe("pipedog: createTransport", () => {
  const telnyxStart = {
    event: "start",
    sequence_number: "1",
    stream_id: "stream-abc",
    start: {
      call_control_id: "v3:cc-123",
      from: "+15551234567",
      to: "+15559876543",
      media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
    },
  };
  const params = { telnyx: () => new FastAPIWebsocketParams({ allowedOrigins: [] }) };

  test("Telnyx connected then start builds a TelnyxFrameSerializer with the call's IDs", async () => {
    const ws = connectionWith([{ event: "connected", version: "1.0.0" }, telnyxStart]);
    const args = new WebSocketRunnerArguments({ websocket: ws });
    const transport = await createTransport(args, params);
    const serializer = (transport as any)._params.serializer as TelnyxFrameSerializer;
    expect(serializer).toBeInstanceOf(TelnyxFrameSerializer);
    expect((serializer as any)._streamId).toBe("stream-abc");
    expect((serializer as any)._callControlId).toBe("v3:cc-123");
    expect(args.transportType).toBe("telnyx");
    expect(args.callData!.callId).toBe("v3:cc-123");
    expect(args.handshake?.status).toBe("started");
    expect((transport as any)._params.addWavHeader).toBe(false);
  });

  test("a caller who hangs up after connected, before start, is a TelephonyCallEndedError", async () => {
    const ws = connectionWith([{ event: "connected", version: "1.0.0" }], true);
    const args = new WebSocketRunnerArguments({ websocket: ws });
    const error = await createTransport(args, params).catch((e) => e);
    expect(error).toBeInstanceOf(TelephonyCallEndedError);
    expect(error).toBeInstanceOf(TelephonyHandshakeError);
    expect(error.handshake).toEqual({ status: "closed", messagesReceived: 1 });
    expect(args.handshake).toEqual({ status: "closed", messagesReceived: 1 });
    expect(args.callData).toBeNull();
  });

  test("a socket that closes before any message is a TelephonyCallEndedError", async () => {
    const args = new WebSocketRunnerArguments({ websocket: connectionWith([], true) });
    const error = await createTransport(args, params).catch((e) => e);
    expect(error).toBeInstanceOf(TelephonyCallEndedError);
    expect(args.handshake).toEqual({ status: "closed", messagesReceived: 0 });
  });

  test("missing transport params name the key", async () => {
    const ws = connectionWith([telnyxStart], true);
    const args = new WebSocketRunnerArguments({ websocket: ws });
    await expect(createTransport(args, {})).rejects.toThrow(
      "Missing transport params for 'telnyx'",
    );
  });

  test("a plain WebSocket session uses the 'websocket' params", async () => {
    const args = new WebSocketRunnerArguments({
      websocket: connectionWith([]),
      transportType: "websocket",
    });
    const transport = await createTransport(args, {
      websocket: () => new FastAPIWebsocketParams({ allowedOrigins: [] }),
    });
    expect(transport).toBeInstanceOf(FastAPIWebsocketTransport);
  });

  test("unported transports fail clearly", async () => {
    for (const args of [
      new DailyRunnerArguments({ roomUrl: "https://x.daily.co/r" }),
      new VonageRunnerArguments({ applicationId: "a", vonageSessionId: "s", token: "t" }),
      new MOQRunnerArguments({ serve: true }),
    ]) {
      const any = { daily: () => ({}), livekit: () => ({}), vonage: () => ({}), moq: () => ({}) };
      await expect(createTransport(args, any)).rejects.toBeInstanceOf(TransportNotPortedError);
    }
  });

  test("LiveKitRunnerArguments build a LiveKitTransport", async () => {
    const args = new LiveKitRunnerArguments({ roomName: "r", url: "wss://x", token: "t" });
    const transport = await createTransport(args, {
      livekit: () => new LiveKitParams({ audioInEnabled: true }),
    });
    expect(transport).toBeInstanceOf(LiveKitTransport);
    const client = (transport as LiveKitTransport)._client;
    expect([client._url, client._token, client._roomName]).toEqual(["wss://x", "t", "r"]);
    expect(client._params.audioInEnabled).toBe(true);
  });

  test("MOQRunnerArguments needs a relay in client mode", () => {
    expect(() => new MOQRunnerArguments()).toThrow("relay_url");
    expect(new MOQRunnerArguments({ host: "h", port: 1 }).path).toBe("/moq");
  });

  test("smallwebrtcSdpMunging drops sha-384/512 fingerprints and foreign candidates", () => {
    const sdp = [
      "v=0",
      "a=fingerprint:sha-256 AA",
      "a=fingerprint:sha-384 BB",
      "a=fingerprint:sha-512 CC",
      "a=candidate:1 1 udp 1 192.168.1.10 5000 typ host",
      "a=candidate:2 1 udp 1 10.0.0.2 5000 typ host",
      "a=candidate:3 1 udp 1 192.168.1.10 6000 typ srflx raddr 0.0.0.0 rport 0",
    ].join("\r\n");
    expect(smallwebrtcSdpMunging(sdp, "192.168.1.10")).toBe(
      "v=0\r\na=fingerprint:sha-256 AA\r\na=candidate:1 1 udp 1 192.168.1.10 5000 typ host\r\n",
    );
    expect(smallwebrtcSdpMunging(sdp, null).split("\r\n").length).toBe(6);
  });
});

describe("TestCreateTransportEval", () => {
  test("test_eval_connect_builds_the_eval_transport_with_its_flags", async () => {
    const flags = new EvalConnectionFlags({ skipTts: true, captureBotAudio: true });
    // Upstream's MagicMock socket: the eval-connect message as raw text.
    const ws = connectionWith([]);
    ws.feedMessage(evalConnectMessage(flags));
    const args = new WebSocketRunnerArguments({ websocket: ws });

    const transport = await createTransport(args, {
      eval: () => new EvalTransportParams({ allowedOrigins: [] }),
    });

    expect(transport).toBeInstanceOf(EvalFastAPIWebsocketTransport);
    expect(args.transportType).toEqual("eval");
    const serializer = (transport as any)._params.serializer;
    expect(serializer).toBeInstanceOf(EvalSerializer);
    expect(serializer._captureAudio).toBe(true);
  });

  test("test_eval_connect_without_eval_params_raises", async () => {
    const ws = connectionWith([]);
    ws.feedMessage(evalConnectMessage(new EvalConnectionFlags()));
    const args = new WebSocketRunnerArguments({ websocket: ws });

    const error = await createTransport(args, {
      twilio: () => new FastAPIWebsocketParams({ allowedOrigins: [] }),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toEqual("ValueError");
    expect(String(error.message)).toContain("'eval'");
  });
});

describe("TestMaybeApplyDailyDialin", () => {
  test.todo("test_dialin_body_populates_params (needs pipecat.transports.daily.transport)");
  test.todo("test_noop_for_non_dialin_body (needs pipecat.transports.daily.transport)");
});

describe("TestGetTransportClientId", () => {
  // get_transport_client_id is deprecated upstream (since 1.13.0) and not ported.
  test.skip("test_is_deprecated_and_asks_the_transport", () => {});
});

describe("TestMaybeCaptureParticipantVideo", () => {
  // maybe_capture_participant_* are deprecated upstream (since 1.13.0) and not ported.
  test.skip("test_is_deprecated", () => {});
});
