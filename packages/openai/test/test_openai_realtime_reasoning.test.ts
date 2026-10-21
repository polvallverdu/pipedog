// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_realtime_reasoning.py

/**
 * Tests for OpenAI Realtime reasoning support (gpt-realtime-2).
 *
 * Covers:
 * - `SessionProperties.reasoning` round-trips through the model layer.
 * - Compatibility heuristic warns when reasoning is configured on a model
 *   that isn't known to support it, and stays quiet otherwise.
 * - Runtime `LLMUpdateSettingsFrame` carrying reasoning triggers a
 *   `session.update` and the outgoing event includes the new reasoning.
 */

import { expect, test } from "bun:test";

import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";

import * as events from "../src/realtime/events.ts";
import { OpenAIRealtimeLLMService } from "../src/realtime/llm.ts";

/** The protected members these tests reach into, as upstream does. */
interface Internals {
  _settings: InstanceType<typeof OpenAIRealtimeLLMService.Settings>;
  _sendSessionUpdate: () => Promise<void>;
  sendClientEvent: (event: events.ClientEvent) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure data: SessionProperties round-trip
// ---------------------------------------------------------------------------

test("test_session_properties_accepts_reasoning_object", () => {
  const sp = new events.SessionProperties({ reasoning: new events.Reasoning({ effort: "high" }) });
  expect(sp.reasoning).not.toBeNull();
  expect(sp.reasoning!.effort).toBe("high");
});

test("test_session_properties_coerces_reasoning_dict", () => {
  // Nested dicts are coerced into Reasoning automatically.
  const sp = events.SessionProperties.modelValidate({ reasoning: { effort: "low" } });
  expect(sp.reasoning).toBeInstanceOf(events.Reasoning);
  expect(sp.reasoning!.effort).toBe("low");
});

test("test_reasoning_accepts_future_effort_strings", () => {
  // Forward compat: unknown effort strings pass through (the field accepts `| string`).
  const r = new events.Reasoning({ effort: "ultra" }); // not in the today's literal set
  expect(r.effort).toBe("ultra");
});

test("test_reasoning_serializes_into_session_update", () => {
  // Confirm the wire shape sent to OpenAI matches the documented schema.
  const sp = new events.SessionProperties({
    reasoning: new events.Reasoning({ effort: "medium" }),
  });
  const dumped = new events.SessionUpdateEvent({ session: sp }).modelDump({ excludeNone: true });
  expect(dumped.session.reasoning).toEqual({ effort: "medium" });
});

// ---------------------------------------------------------------------------
// Strip-on-the-client compatibility behavior
// ---------------------------------------------------------------------------

/** Attach a fresh log sink that captures WARNING-and-above messages. */
function _captureWarnings(): { sink: { value: string }; remove: () => void } {
  const sink = { value: "" };
  const remove = logger.addSink((record) => {
    if (["WARNING", "ERROR", "CRITICAL"].includes(record.level)) {
      sink.value += `${record.message}\n`;
    }
  });
  return { sink, remove };
}

class _EventRecorder {
  events: events.ClientEvent[] = [];

  readonly call = async (event: events.ClientEvent): Promise<void> => {
    this.events.push(event);
  };
}

/** Run `_sendSessionUpdate` and return the outgoing session payload. */
async function _sendAndCapture(
  service: OpenAIRealtimeLLMService,
): Promise<events.SessionProperties> {
  const sent = new _EventRecorder();
  const internals = service as unknown as Internals;
  internals.sendClientEvent = sent.call;
  await internals._sendSessionUpdate();
  const sessionUpdates = sent.events.filter((e) => e instanceof events.SessionUpdateEvent);
  expect(sessionUpdates.length).toBe(1);
  return (sessionUpdates[0] as events.SessionUpdateEvent).session;
}

test("test_outgoing_session_update_strips_reasoning_on_unsupported_model", async () => {
  const service = new OpenAIRealtimeLLMService({
    apiKey: "test-key",
    settings: new OpenAIRealtimeLLMService.Settings({
      model: "gpt-realtime-1.5",
      systemInstruction: "be helpful",
      sessionProperties: new events.SessionProperties({
        reasoning: new events.Reasoning({ effort: "high" }),
      }),
    }),
  });

  const { sink, remove } = _captureWarnings();
  let outgoing: events.SessionProperties;
  try {
    outgoing = await _sendAndCapture(service);
  } finally {
    remove();
  }

  // Stripped on the wire.
  expect(outgoing.reasoning).toBeNull();
  // Warning surfaced for visibility.
  const text = sink.value;
  expect(text).toContain("stripping `reasoning`");
  expect(text).toContain("gpt-realtime-1.5");
  // Stored config preserved — strip happens on a copy.
  const stored = (service as unknown as Internals)._settings
    .sessionProperties as events.SessionProperties;
  expect(stored.reasoning).not.toBeNull();
  expect(stored.reasoning!.effort).toBe("high");
});

test("test_outgoing_session_update_keeps_reasoning_on_supported_model", async () => {
  const service = new OpenAIRealtimeLLMService({
    apiKey: "test-key",
    settings: new OpenAIRealtimeLLMService.Settings({
      model: "gpt-realtime-2",
      systemInstruction: "be helpful",
      sessionProperties: new events.SessionProperties({
        reasoning: new events.Reasoning({ effort: "high" }),
      }),
    }),
  });

  const { sink, remove } = _captureWarnings();
  let outgoing: events.SessionProperties;
  try {
    outgoing = await _sendAndCapture(service);
  } finally {
    remove();
  }

  expect(outgoing.reasoning).not.toBeNull();
  expect(outgoing.reasoning!.effort).toBe("high");
  expect(sink.value).toBe("");
});

test("test_supported_model_variant_keeps_reasoning", async () => {
  // Substring match covers variants of a supported base model (e.g. date suffixes).
  const service = new OpenAIRealtimeLLMService({
    apiKey: "test-key",
    settings: new OpenAIRealtimeLLMService.Settings({
      model: "gpt-realtime-2-some-variant",
      systemInstruction: "be helpful",
      sessionProperties: new events.SessionProperties({
        reasoning: new events.Reasoning({ effort: "high" }),
      }),
    }),
  });

  const { sink, remove } = _captureWarnings();
  let outgoing: events.SessionProperties;
  try {
    outgoing = await _sendAndCapture(service);
  } finally {
    remove();
  }

  expect(outgoing.reasoning).not.toBeNull();
  expect(outgoing.reasoning!.effort).toBe("high");
  expect(sink.value).toBe("");
});

test("test_no_warning_when_reasoning_is_unset_on_unsupported_model", async () => {
  const service = new OpenAIRealtimeLLMService({
    apiKey: "test-key",
    settings: new OpenAIRealtimeLLMService.Settings({
      model: "gpt-realtime-1.5",
      systemInstruction: "be helpful",
    }),
  });

  const { sink, remove } = _captureWarnings();
  let outgoing: events.SessionProperties;
  try {
    outgoing = await _sendAndCapture(service);
  } finally {
    remove();
  }

  expect(outgoing.reasoning).toBeNull();
  expect(sink.value).toBe("");
});

// ---------------------------------------------------------------------------
// Runtime updates via LLMUpdateSettingsFrame
// ---------------------------------------------------------------------------

test("test_runtime_settings_update_with_reasoning_triggers_session_update", async () => {
  const service = new OpenAIRealtimeLLMService({
    apiKey: "test-key",
    settings: new OpenAIRealtimeLLMService.Settings({
      model: "gpt-realtime-2",
      systemInstruction: "be helpful",
      sessionProperties: new events.SessionProperties({
        reasoning: new events.Reasoning({ effort: "low" }),
      }),
    }),
  });

  const sent = new _EventRecorder();
  (service as unknown as Internals).sendClientEvent = sent.call;

  // Send a runtime update that changes reasoning effort.
  const newSp = new events.SessionProperties({
    reasoning: new events.Reasoning({ effort: "high" }),
  });
  const delta = new OpenAIRealtimeLLMService.Settings({ sessionProperties: newSp });
  await service.processFrame(new LLMUpdateSettingsFrame({ delta }), FrameDirection.DOWNSTREAM);

  const sessionUpdates = sent.events.filter((e) => e instanceof events.SessionUpdateEvent);
  expect(sessionUpdates.length).toBe(1);
  const sentSession = (sessionUpdates[0] as events.SessionUpdateEvent).session;
  expect(sentSession.reasoning).not.toBeNull();
  expect(sentSession.reasoning!.effort).toBe("high");
});

test("test_runtime_settings_update_strips_reasoning_on_unsupported_model", async () => {
  // Runtime updates honor the same strip-on-the-client rule as init-time.
  const service = new OpenAIRealtimeLLMService({
    apiKey: "test-key",
    settings: new OpenAIRealtimeLLMService.Settings({
      model: "gpt-realtime-1.5",
      systemInstruction: "be helpful",
    }),
  });

  const sent = new _EventRecorder();
  (service as unknown as Internals).sendClientEvent = sent.call;

  const newSp = new events.SessionProperties({
    reasoning: new events.Reasoning({ effort: "high" }),
  });
  const delta = new OpenAIRealtimeLLMService.Settings({ sessionProperties: newSp });

  const { sink, remove } = _captureWarnings();
  try {
    await service.processFrame(new LLMUpdateSettingsFrame({ delta }), FrameDirection.DOWNSTREAM);
  } finally {
    remove();
  }

  const sessionUpdates = sent.events.filter((e) => e instanceof events.SessionUpdateEvent);
  expect(sessionUpdates.length).toBe(1);
  expect((sessionUpdates[0] as events.SessionUpdateEvent).session.reasoning).toBeNull();
  expect(sink.value).toContain("stripping `reasoning`");
});
