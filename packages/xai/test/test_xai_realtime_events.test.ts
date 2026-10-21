// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_xai_realtime_events.py

/** Tests for xAI (Grok) Realtime server event parsing and handling. */

import { expect, test } from "bun:test";

import * as events from "../src/realtime/events.ts";

function _event(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

test("test_parse_session_created_from_live_shape", () => {
  // session.created is emitted on every connect and must parse cleanly.
  const raw = _event({
    type: "session.created",
    event_id: "evt-1",
    session: {
      id: "sess-1",
      object: "realtime.session",
      instructions: "",
      voice: "xai_ara",
      modalities: ["audio"],
      turn_detection: { type: null },
      tools: [],
      model: "grok-voice-think-fast-2.0",
    },
  });

  const evt = events.parseServerEvent(raw);

  expect(evt).toBeInstanceOf(events.SessionCreatedEvent);
  const session = (evt as events.SessionCreatedEvent).session;
  expect(session.voice).toBe("xai_ara");
  expect(session.turnDetection).not.toBeNull();
  expect(session.turnDetection!.type).toBeNull();
});

test("test_parse_transcription_updated_is_cumulative", () => {
  const raw = _event({
    type: "conversation.item.input_audio_transcription.updated",
    event_id: "evt-2",
    item_id: "item-1",
    content_index: 0,
    transcript: "hello there",
  });

  const evt = events.parseServerEvent(raw);

  expect(evt).toBeInstanceOf(events.ConversationItemInputAudioTranscriptionUpdated);
  expect((evt as events.ConversationItemInputAudioTranscriptionUpdated).transcript).toBe(
    "hello there",
  );
});

test.each(["response.output_text.delta", "response.text.delta"])(
  "test_parse_text_delta_aliases[%s]",
  (eventType) => {
    const raw = _event({
      type: eventType,
      event_id: "evt-3",
      response_id: "resp-1",
      item_id: "item-1",
      output_index: 0,
      content_index: 0,
      delta: "Hi",
    });

    const evt = events.parseServerEvent(raw);

    expect(evt).toBeInstanceOf(events.ResponseTextDelta);
    expect((evt as events.ResponseTextDelta).delta).toBe("Hi");
  },
);

test.each([
  "conversation.item.deleted",
  "conversation.item.truncated",
  "input_audio_buffer.timeout_triggered",
  "input_audio_buffer.dtmf_event_received",
  "mcp_list_tools.in_progress",
  "mcp_list_tools.completed",
  "mcp_list_tools.failed",
  "response.mcp_call_arguments.delta",
  "response.mcp_call_arguments.done",
  "response.mcp_call.in_progress",
  "response.mcp_call.completed",
  "response.mcp_call.failed",
])("test_documented_server_events_are_registered[%s]", (eventType) => {
  // Every documented server event type should parse without raising.
  const payload: Record<string, unknown> = { type: eventType, event_id: "evt-x" };
  if (eventType === "conversation.item.deleted") {
    payload.item_id = "item-1";
  } else if (eventType === "conversation.item.truncated") {
    Object.assign(payload, { item_id: "item-1", content_index: 0, audio_end_ms: 250 });
  } else if (eventType === "input_audio_buffer.timeout_triggered") {
    payload.item_id = "item-1";
  } else if (eventType === "input_audio_buffer.dtmf_event_received") {
    payload.digit = "5";
  } else if (eventType.includes("mcp_call_arguments")) {
    Object.assign(payload, { delta: "{}", arguments: "{}", name: "tool", call_id: "c1" });
  }

  const evt = events.parseServerEvent(_event(payload));
  expect(evt.type).toBe(eventType);
});

test("test_unknown_event_still_raises", () => {
  expect(() =>
    events.parseServerEvent(_event({ type: "not.a.real.event", event_id: "e" })),
  ).toThrow("Unimplemented server event type");
});

test("test_client_truncate_and_delete_events_serialize", () => {
  const truncate = new events.ConversationItemTruncateEvent({
    itemId: "item-1",
    contentIndex: 0,
    audioEndMs: 250,
  });
  const del = new events.ConversationItemDeleteEvent({ itemId: "item-1" });
  expect(truncate.modelDump({ excludeNone: true }).type).toBe("conversation.item.truncate");
  expect(del.modelDump({ excludeNone: true }).type).toBe("conversation.item.delete");
});

test("test_session_properties_accept_extended_fields", () => {
  const props = new events.SessionProperties({
    reasoning: new events.Reasoning({ effort: "none" }),
    resumption: new events.SessionResumption({ enabled: true }),
    replace: { "Acme Mobile": "Acme Mobull" },
    turnDetection: new events.TurnDetection({
      type: "server_vad",
      idleTimeoutMs: 5000,
      threshold: 0.85,
    }),
    audio: new events.AudioConfiguration({
      input: new events.AudioInput({
        transcription: new events.InputAudioTranscription({ model: "grok-transcribe" }),
      }),
    }),
  });
  const dumped = props.modelDump({ excludeNone: true });
  expect(dumped.reasoning.effort).toBe("none");
  expect(dumped.resumption.enabled).toBe(true);
  expect(dumped.turn_detection.idle_timeout_ms).toBe(5000);
  expect(dumped.audio.input.transcription.model).toBe("grok-transcribe");
});
