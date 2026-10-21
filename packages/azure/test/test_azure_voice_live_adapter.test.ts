// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_azure_voice_live_adapter.py

/**
 * Tests for the Azure Voice Live LLM adapter.
 *
 * The adapter converts the universal context and tool schemas into the shapes
 * the Voice Live API accepts. It has no I/O, so these tests call it directly.
 */

import { beforeEach, expect, test } from "bun:test";

import { FunctionSchema } from "@pipedog/core/adapters/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import {
  LLMContext,
  type LLMContextMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { pyJsonLoads } from "@pipedog/core/utils/py_json";

import { AzureVoiceLiveLLMAdapter } from "../src/azure_voice_live_adapter.ts";

const WEATHER = new FunctionSchema({
  name: "get_current_weather",
  description: "Get the current weather.",
  properties: { location: { type: "string" } },
  required: ["location"],
});

let adapter: AzureVoiceLiveLLMAdapter;

beforeEach(() => {
  adapter = new AzureVoiceLiveLLMAdapter();
});

test("test_provider_id", () => {
  expect(adapter.idForLlmSpecificMessages).toBe("azure-voice-live");
});

test("test_tools_convert_to_the_voice_live_shape", () => {
  const tools = adapter.toProviderToolsFormat(new ToolsSchema({ standardTools: [WEATHER] }));

  expect(tools).toEqual([
    {
      type: "function",
      name: "get_current_weather",
      description: "Get the current weather.",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      },
    },
  ]);
});

test("test_a_single_user_message_is_sent_as_one_item", async () => {
  const context = new LLMContext({ messages: [{ role: "user", content: "Hello there." }] });

  const params = await adapter.getLlmInvocationParams(context);

  expect(params.messages.length).toBe(1);
  const item = params.messages[0]!;
  expect(item.role).toBe("user");
  expect(item.type).toBe("message");
  expect(item.content![0]!.type).toBe("input_text");
  expect(item.content![0]!.text).toBe("Hello there.");
});

test("test_a_leading_system_message_becomes_the_session_instruction", async () => {
  const context = new LLMContext({
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi." },
    ],
  });

  const params = await adapter.getLlmInvocationParams(context);

  expect(params.system_instruction).toBe("Be brief.");
  expect(params.messages.length).toBe(1);
  expect(params.messages[0]!.content![0]!.text).toBe("Hi.");
});

test("test_an_init_system_instruction_wins_over_the_context", async () => {
  const context = new LLMContext({ messages: [{ role: "system", content: "From context." }] });

  const params = await adapter.getLlmInvocationParams(context, {
    systemInstruction: "From init.",
  });

  expect(params.system_instruction).toBe("From init.");
});

test("test_a_system_only_context_sends_no_messages", async () => {
  const context = new LLMContext({ messages: [{ role: "system", content: "Be brief." }] });

  const params = await adapter.getLlmInvocationParams(context);

  expect(params.messages).toEqual([]);
  expect(params.system_instruction).toBe("Be brief.");
});

test("test_an_empty_context_sends_nothing", async () => {
  const params = await adapter.getLlmInvocationParams(new LLMContext({ messages: [] }));

  expect(params.messages).toEqual([]);
  expect(params.system_instruction).toBeNull();
});

test("test_a_history_is_packed_into_one_user_message", async () => {
  // The realtime API has no way to load a long history.
  const context = new LLMContext({
    messages: [
      { role: "user", content: "What is the capital of France?" },
      { role: "assistant", content: "Paris." },
      { role: "user", content: "And of Spain?" },
    ],
  });

  const params = await adapter.getLlmInvocationParams(context);

  expect(params.messages.length).toBe(1);
  const packed = params.messages[0]!;
  expect(packed.role).toBe("user");
  const text = packed.content![0]!.text!;
  expect(text).toContain("previously saved conversation");
  expect(text).toContain("What is the capital of France?");
  expect(text).toContain("Paris.");
  expect(text).toContain("And of Spain?");
});

test("test_list_content_is_flattened_to_text", async () => {
  const context = new LLMContext({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is" },
          { type: "text", text: "the time?" },
        ],
      },
    ],
  });

  const params = await adapter.getLlmInvocationParams(context);

  expect(params.messages[0]!.content![0]!.text).toBe("What is the time?");
});

test("test_an_assistant_tool_call_becomes_a_function_call_item", () => {
  const message = {
    role: "assistant",
    tool_calls: [
      {
        id: "call_1",
        function: { name: "get_current_weather", arguments: '{"location":"Pune"}' },
      },
    ],
  };

  const item = adapter._fromUniversalContextMessage(message);

  expect(item.type).toBe("function_call");
  expect(item.callId).toBe("call_1");
  expect(item.name).toBe("get_current_weather");
  expect(pyJsonLoads(item.arguments!)).toEqual({ location: "Pune" });
});

test("test_an_unhandled_message_role_raises", () => {
  expect(() =>
    adapter._fromUniversalContextMessage({
      role: "tool",
      content: "result",
    } as unknown as LLMContextMessage),
  ).toThrow(Error);
});

test("test_context_tools_reach_the_invocation_params", async () => {
  const context = new LLMContext({
    messages: [{ role: "user", content: "Weather?" }],
    tools: [WEATHER],
  });

  const params = await adapter.getLlmInvocationParams(context);

  expect(params.tools.map((t) => t.name)).toEqual(["get_current_weather"]);
});
