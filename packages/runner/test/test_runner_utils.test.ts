// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_runner_utils.py

/**
 * The telephony parts of upstream's runner utils tests: `CallData` and
 * `parse_telephony_websocket`. The rest needs modules that are not ported yet
 * (`pipecat.evals`, `create_transport`, the Daily transport) and is `todo`.
 *
 * Upstream mocks the socket with `MagicMock().iter_text.return_value =
 * MockAsyncIterator([...])`; here the socket is a stand-in with Starlette's
 * `receive()`, which `parseTelephonyWebsocket` reads.
 */

import { describe, expect, test } from "bun:test";

import { CallData, ExotelCallData, TelnyxCallData } from "../src/types.ts";
import {
  parseTelephonyWebsocket,
  type TelephonyWebsocket,
  type TelephonyWebsocketMessage,
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

  // call_data lives on RunnerArguments, which is not ported (only the
  // telephony types are).
  test.todo("test_call_data_is_a_base_field (needs pipecat.runner.types.RunnerArguments)");
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
  test.todo("test_eval_connect_detected_from_first_message (needs pipecat.evals.serializer)");
  test.todo("test_eval_connect_leaves_the_next_message_unread (needs pipecat.evals.serializer)");
});

describe("TestCreateTransportExposesCallData", () => {
  test.todo(
    "test_telephony_call_data_set_on_runner_args (needs pipecat.runner.utils.create_transport)",
  );
});

describe("TestCreateTransportEval", () => {
  test.todo(
    "test_eval_connect_builds_the_eval_transport_with_its_flags (needs pipecat.evals.transport)",
  );
  test.todo("test_eval_connect_without_eval_params_raises (needs pipecat.evals.transport)");
});

describe("TestMaybeApplyDailyDialin", () => {
  test.todo("test_dialin_body_populates_params (needs pipecat.transports.daily.transport)");
  test.todo("test_noop_for_non_dialin_body (needs pipecat.transports.daily.transport)");
});

describe("TestGetTransportClientId", () => {
  test.todo("test_is_deprecated_and_asks_the_transport (deprecated upstream; not ported)");
});

describe("TestMaybeCaptureParticipantVideo", () => {
  test.todo("test_is_deprecated (deprecated upstream; not ported)");
});
