// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_bus_json_serializer.py

/** Unit tests for JSONMessageSerializer's ToolsSchema/LLMContext adapters. */

import { beforeEach, describe, expect, test } from "bun:test";
import { FunctionSchema } from "../src/adapters/schemas/function_schema.ts";
import { AdapterType, ToolsSchema } from "../src/adapters/schemas/tools_schema.ts";
import { BusFrameMessage } from "../src/bus/messages.ts";
import { JSONMessageSerializer } from "../src/bus/serializers/json.ts";
import { LLMContextFrame } from "../src/frames/frames.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";

/** Exposes the protected helpers the upstream test calls directly. */
class TestableSerializer extends JSONMessageSerializer {
  serializeValue(value: unknown): unknown {
    return this._serializeValue(value);
  }

  deserializeValue(value: unknown): unknown {
    return this._deserializeValue(value);
  }
}

/**
 * Bus adapters must preserve `ToolsSchema.customTools` (e.g. Gemini's
 * `google_search`) when a frame crosses a network bus (Redis/pgmq), not
 * just the in-process case.
 */
describe("TestToolsSchemaCustomToolsRoundTrip", () => {
  let serializer: TestableSerializer;
  let standardTool: FunctionSchema;

  beforeEach(() => {
    serializer = new TestableSerializer();
    standardTool = new FunctionSchema({
      name: "get_weather",
      description: "Get the weather",
      properties: { location: { type: "string" } },
      required: ["location"],
    });
  });

  test("test_tools_schema_preserves_custom_tools", () => {
    const tools = new ToolsSchema({
      standardTools: [standardTool],
      customTools: { [AdapterType.GEMINI]: [{ google_search: {} }] },
    });

    const data = serializer.serializeValue(tools);
    const restored = serializer.deserializeValue(data) as ToolsSchema;

    expect(restored).toBeInstanceOf(ToolsSchema);
    expect(restored.standardTools.length).toEqual(1);
    expect(restored.standardTools[0]!.name).toEqual("get_weather");
    expect(restored.customTools).toEqual({ [AdapterType.GEMINI]: [{ google_search: {} }] });
  });

  test("test_tools_schema_without_custom_tools_round_trips_to_none", () => {
    const tools = new ToolsSchema({ standardTools: [standardTool] });

    const data = serializer.serializeValue(tools);
    const restored = serializer.deserializeValue(data) as ToolsSchema;

    expect(restored.customTools).toBeNull();
  });

  test("test_llm_context_tools_preserve_custom_tools", () => {
    const tools = new ToolsSchema({
      standardTools: [standardTool],
      customTools: { [AdapterType.OPENAI]: [{ type: "web_search" }] },
    });
    const context = new LLMContext({ messages: [{ role: "user", content: "hi" }], tools });

    const data = serializer.serializeValue(context);
    const restored = serializer.deserializeValue(data) as LLMContext;

    expect(restored).toBeInstanceOf(LLMContext);
    expect((restored.tools as ToolsSchema).customTools).toEqual({
      [AdapterType.OPENAI]: [{ type: "web_search" }],
    });
  });

  test("test_bytes_round_trip_through_serialize_deserialize", () => {
    // End-to-end sanity check that the full JSON encode/decode cycle preserves custom_tools.
    // Mirrors an `LLMContextFrame` crossing a network bus (Redis/pgmq).
    const tools = new ToolsSchema({
      standardTools: [standardTool],
      customTools: { [AdapterType.GEMINI]: [{ google_search: {} }] },
    });
    const context = new LLMContext({ messages: [{ role: "user", content: "hi" }], tools });
    const message = new BusFrameMessage({
      source: "worker-a",
      frame: new LLMContextFrame({ context }),
      direction: FrameDirection.DOWNSTREAM,
    });

    const raw = serializer.serialize(message);
    const restoredMessage = serializer.deserialize(raw) as BusFrameMessage;

    expect(
      ((restoredMessage.frame as LLMContextFrame).context.tools as ToolsSchema).customTools,
    ).toEqual({ [AdapterType.GEMINI]: [{ google_search: {} }] });
  });
});
