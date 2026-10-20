// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_frame_adapters.py

import { beforeEach, describe, expect, test } from "bun:test";
import { FunctionSchema } from "../src/adapters/schemas/function_schema.ts";
import { ToolsSchema } from "../src/adapters/schemas/tools_schema.ts";
import { BusFrameMessage } from "../src/bus/messages.ts";
import { JSONMessageSerializer } from "../src/bus/serializers/json.ts";
import { LLMContextFrame, TextFrame, TranscriptionFrame } from "../src/frames/frames.ts";
import {
  LLMContext,
  LLMSpecificMessage,
  NotGiven,
} from "../src/processors/aggregators/llm_context.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { Language } from "../src/transcriptions/language.ts";

/** Round-trips a bus message through the serializer, as the upstream tests do. */
function roundTrip(serializer: JSONMessageSerializer, msg: BusFrameMessage): BusFrameMessage {
  const data = serializer.serialize(msg);
  return serializer.deserialize(data) as BusFrameMessage;
}

describe("TestTextFrameRoundTrip", () => {
  let serializer: JSONMessageSerializer;

  beforeEach(() => {
    serializer = new JSONMessageSerializer();
  });

  test("test_round_trip", () => {
    const msg = new BusFrameMessage({
      source: "a",
      frame: new TextFrame({ text: "hello world" }),
      direction: FrameDirection.DOWNSTREAM,
    });
    const restored = roundTrip(serializer, msg);

    expect(restored.frame).toBeInstanceOf(TextFrame);
    expect((restored.frame as TextFrame).text).toEqual("hello world");
  });
});

describe("TestTranscriptionFrameRoundTrip", () => {
  let serializer: JSONMessageSerializer;

  beforeEach(() => {
    serializer = new JSONMessageSerializer();
  });

  test("test_round_trip_basic", () => {
    const msg = new BusFrameMessage({
      source: "a",
      frame: new TranscriptionFrame({
        text: "hello",
        userId: "user-1",
        timestamp: "2026-03-17T00:00:00Z",
      }),
      direction: FrameDirection.DOWNSTREAM,
    });
    const restored = roundTrip(serializer, msg);

    expect(restored.frame).toBeInstanceOf(TranscriptionFrame);
    const frame = restored.frame as TranscriptionFrame;
    expect(frame.text).toEqual("hello");
    expect(frame.userId).toEqual("user-1");
    expect(frame.timestamp).toEqual("2026-03-17T00:00:00Z");
    expect(frame.language).toBeNull();
    expect(frame.finalized).toBe(false);
  });

  test("test_round_trip_with_language", () => {
    const msg = new BusFrameMessage({
      source: "a",
      frame: new TranscriptionFrame({
        text: "hola",
        userId: "user-1",
        timestamp: "2026-03-17T00:00:00Z",
        language: Language.ES,
        finalized: true,
      }),
      direction: FrameDirection.DOWNSTREAM,
    });
    const restored = roundTrip(serializer, msg);

    const frame = restored.frame as TranscriptionFrame;
    expect(frame.language).toEqual(Language.ES);
    expect(frame.finalized).toBe(true);
  });
});

describe("TestLLMContextFrameRoundTrip", () => {
  let serializer: JSONMessageSerializer;

  beforeEach(() => {
    serializer = new JSONMessageSerializer();
  });

  function roundTripContext(ctx: LLMContext): LLMContext {
    const msg = new BusFrameMessage({
      source: "a",
      frame: new LLMContextFrame({ context: ctx }),
      direction: FrameDirection.DOWNSTREAM,
    });
    const restored = roundTrip(serializer, msg);
    expect(restored.frame).toBeInstanceOf(LLMContextFrame);
    return (restored.frame as LLMContextFrame).context;
  }

  test("test_round_trip_messages_only", () => {
    const ctx = new LLMContext({
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hello" },
      ],
    });
    const restored = roundTripContext(ctx);

    expect(restored.messages.length).toEqual(2);
    expect((restored.messages[0] as Record<string, unknown>).role).toEqual("system");
    expect((restored.messages[1] as Record<string, unknown>).content).toEqual("hello");
    expect(restored.tools).toBeInstanceOf(NotGiven);
    expect(restored.toolChoice).toBeInstanceOf(NotGiven);
  });

  test("test_round_trip_with_specific_message", () => {
    const ctx = new LLMContext({
      messages: [
        { role: "user", content: "hi" },
        new LLMSpecificMessage({ llm: "anthropic", message: { custom: "data" } }),
      ],
    });
    const restored = roundTripContext(ctx);

    expect(restored.messages.length).toEqual(2);
    // Python: assertIsInstance(restored.messages[0], dict)
    expect(typeof restored.messages[0]).toEqual("object");
    expect(restored.messages[0]).not.toBeInstanceOf(LLMSpecificMessage);
    expect(restored.messages[1]).toBeInstanceOf(LLMSpecificMessage);
    const specific = restored.messages[1] as LLMSpecificMessage;
    expect(specific.llm).toEqual("anthropic");
    expect(specific.message).toEqual({ custom: "data" });
  });

  test("test_round_trip_with_tools", () => {
    const tools = new ToolsSchema({
      standardTools: [
        new FunctionSchema({
          name: "get_weather",
          description: "Get the weather",
          properties: { location: { type: "string" } },
          required: ["location"],
        }),
      ],
    });
    const ctx = new LLMContext({
      messages: [{ role: "user", content: "weather?" }],
      tools,
    });
    const restored = roundTripContext(ctx);

    expect(restored.tools).not.toBeInstanceOf(NotGiven);
    const restoredTools = restored.tools as ToolsSchema;
    expect(restoredTools.standardTools.length).toEqual(1);
    expect(restoredTools.standardTools[0]!.name).toEqual("get_weather");
    expect(restoredTools.standardTools[0]!.required).toEqual(["location"]);
  });

  test("test_round_trip_with_tool_choice", () => {
    const ctx = new LLMContext({
      messages: [{ role: "user", content: "hi" }],
      toolChoice: "auto",
    });
    const restored = roundTripContext(ctx);

    expect(restored.toolChoice).toEqual("auto");
  });
});
