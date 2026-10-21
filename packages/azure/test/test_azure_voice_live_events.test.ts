// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_azure_voice_live_events.py

/**
 * Tests for Azure Voice Live server event parsing and session serialization.
 *
 * The payloads below are captured from a live Voice Live session
 * (api-version 2026-07-15, model gpt-4o-mini), with audio deltas truncated.
 */

import { expect, test } from "bun:test";

import { pyJsonDumps, pyJsonLoads } from "@pipedog/core/utils/py_json";

import * as events from "../src/voice_live/events.ts";

function _event(payload: Record<string, unknown>): string {
  return pyJsonDumps(payload);
}

test("test_parse_conversation_item_created_with_empty_previous_item_id", () => {
  // The service sends an empty string, not null, for the first item.
  const raw = _event({
    event_id: "event_2",
    type: "conversation.item.created",
    previous_item_id: "",
    item: {
      id: "item_1",
      object: "realtime.item",
      type: "message",
      status: "completed",
      role: "user",
      content: [{ type: "input_text", text: "Say hello in five words." }],
    },
  });

  const evt = events.parseServerEvent(raw) as events.ConversationItemCreated;

  expect(evt).toBeInstanceOf(events.ConversationItemCreated);
  expect(evt.previousItemId).toBe("");
  expect(evt.item.role).toBe("user");
  expect(evt.item.content).not.toBeNull();
  expect(evt.item.content![0]!.text).toBe("Say hello in five words.");
});

test("test_parse_output_item_added_is_incomplete", () => {
  // An assistant item is announced before its content exists.
  const raw = _event({
    event_id: "event_3",
    type: "response.output_item.added",
    response_id: "resp_1",
    output_index: 0,
    item: {
      id: "msg_1",
      object: "realtime.item",
      type: "message",
      status: "incomplete",
      role: "assistant",
      content: [],
    },
  });

  const evt = events.parseServerEvent(raw) as events.ResponseOutputItemAdded;

  expect(evt).toBeInstanceOf(events.ResponseOutputItemAdded);
  expect(evt.item.status).toBe("incomplete");
  expect(evt.item.role).toBe("assistant");
});

test("test_parse_response_done_exposes_usage_and_status", () => {
  // Token usage drives LLM usage metrics, and carries unmodeled extras.
  const raw = _event({
    event_id: "event_6",
    type: "response.done",
    response: {
      object: "realtime.response",
      id: "resp_1",
      status: "completed",
      status_details: null,
      output: [
        {
          id: "msg_1",
          object: "realtime.item",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "audio", transcript: "Hello! How are you today?" }],
        },
      ],
      usage: {
        total_tokens: 65,
        input_tokens: 23,
        output_tokens: 42,
        input_token_details: {
          cached_tokens: 0,
          text_tokens: 23,
          audio_tokens: 0,
          image_tokens: 0,
        },
        output_token_details: { text_tokens: 10, audio_tokens: 32 },
      },
    },
  });

  const evt = events.parseServerEvent(raw) as events.ResponseDone;

  expect(evt).toBeInstanceOf(events.ResponseDone);
  expect(evt.status).toBe("completed");
  const usage = evt.usage;
  expect(usage).not.toBeNull();
  expect(usage!.totalTokens).toBe(65);
  expect(usage!.inputTokens).toBe(23);
  expect(usage!.outputTokens).toBe(42);
});

test("test_parse_function_call_arguments_done", () => {
  const raw = _event({
    event_id: "event_7",
    type: "response.function_call_arguments.done",
    response_id: "resp_1",
    item_id: "fc_1",
    output_index: 0,
    call_id: "call_1",
    name: "get_weather",
    arguments: '{"city":"Pune"}',
  });

  const evt = events.parseServerEvent(raw) as events.ResponseFunctionCallArgumentsDone;

  expect(evt).toBeInstanceOf(events.ResponseFunctionCallArgumentsDone);
  expect(evt.callId).toBe("call_1");
  expect(pyJsonLoads(evt.arguments)).toEqual({ city: "Pune" });
});

test("test_parse_error_event", () => {
  const raw = _event({
    event_id: "event_8",
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "response_cancel_not_active",
      message: "No active response to cancel.",
    },
  });

  const evt = events.parseServerEvent(raw) as events.ErrorEvent;

  expect(evt).toBeInstanceOf(events.ErrorEvent);
  expect(evt.error.code).toBe("response_cancel_not_active");
});

test("test_parse_unmodeled_event_returns_none", () => {
  // Avatar and animation events are ignored rather than raising.
  const raw = _event({ type: "session.avatar.switch_to_speaking", event_id: "event_9" });

  expect(events.parseServerEvent(raw)).toBeNull();
});

test("test_session_update_serializes_flat", () => {
  // Voice Live carries audio settings on the session, not under `audio`.
  const session = new events.SessionProperties({
    instructions: "Be brief.",
    modalities: ["text", "audio"],
    voice: new events.AzureStandardVoice({ name: "en-US-Ava:DragonHDLatestNeural" }),
    inputAudioFormat: "pcm16",
    outputAudioFormat: "pcm16",
    inputAudioSamplingRate: 16000,
    turnDetection: new events.TurnDetection({
      type: "azure_semantic_vad",
      silenceDurationMs: 500,
    }),
    inputAudioTranscription: new events.InputAudioTranscription({ model: "azure-speech" }),
    inputAudioNoiseReduction: new events.InputAudioNoiseReduction(),
  });

  const payload = new events.SessionUpdateEvent({ session }).modelDump({ excludeNone: true });

  expect(payload.type).toBe("session.update");
  expect("audio" in payload.session).toBe(false);
  expect(payload.session.turn_detection.type).toBe("azure_semantic_vad");
  expect(payload.session.voice).toEqual({
    type: "azure-standard",
    name: "en-US-Ava:DragonHDLatestNeural",
  });
  expect(payload.session.input_audio_sampling_rate).toBe(16000);
  expect(payload.session.input_audio_noise_reduction.type).toBe("azure_deep_noise_suppression");
});

test("test_every_supported_azure_transcription_model_is_accepted", () => {
  // The models Voice Live lists as supported for cascaded pipelines.
  for (const model of [
    "azure-speech",
    "azure-mrs",
    "mai-transcribe",
    "mai-transcribe-1",
    "mai-transcribe-1.5",
    "mai-transcribe-2",
    "mai-transcribe-2-streaming",
    "mai-transcribe-medical",
  ] as const) {
    expect(new events.InputAudioTranscription({ model }).model).toBe(model);
  }
});

test("test_unset_session_fields_are_omitted", () => {
  // Only what the caller configured is sent, so server defaults stand.
  const payload = new events.SessionUpdateEvent({
    session: new events.SessionProperties({ instructions: "Be brief." }),
  }).modelDump({ excludeNone: true });

  expect(payload.session).toEqual({ instructions: "Be brief." });
});
