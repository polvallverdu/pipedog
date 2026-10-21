// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_get_llm_invocation_params.py

/**
 * Unit tests for DeepSeekLLMAdapter's getLlmInvocationParams().
 *
 * Porting note: this is the `TestDeepSeekGetLLMInvocationParams` class of
 * upstream's tests/test_get_llm_invocation_params.py. The rest of that file
 * covers other providers' adapters, and its port belongs to
 * @pipedog/anthropic.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { DeepSeekLLMAdapter } from "../src/deepseek_adapter.ts";

describe("TestDeepSeekGetLLMInvocationParams", () => {
  // DeepSeek doesn't support the "developer" role, so DeepSeekLLMService sets
  // supportsDeveloperRole = false. Tests below pass convertDeveloperToUser:
  // true to match production behavior.

  let adapter: DeepSeekLLMAdapter;

  beforeEach(() => {
    adapter = new DeepSeekLLMAdapter();
  });

  function toolCall(): Record<string, unknown> {
    return {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"location": "LA"}' },
    };
  }

  async function invoke(context: LLMContext) {
    return adapter.getLlmInvocationParams(context, { convertDeveloperToUser: true });
  }

  test("test_tool_call_message_gets_empty_reasoning_content", async () => {
    // An assistant tool-call message without reasoning_content gets an empty one.
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Weather in LA?" },
        { role: "assistant", tool_calls: [toolCall()] },
        { role: "tool", content: '{"temperature": "75"}', tool_call_id: "call_1" },
      ] as any,
    });
    const params = await invoke(context);

    const assistant = params.messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.reasoning_content).toBe("");
    expect(assistant.tool_calls).toEqual([toolCall()]);
  });

  test("test_spoken_text_before_tool_call_also_stamped", async () => {
    // Assistant text recorded before a tool call (e.g. spoken via TTS) is stamped too.
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Weather in LA?" },
        { role: "assistant", content: "Let me check on that." },
        { role: "assistant", tool_calls: [toolCall()] },
        { role: "tool", content: '{"temperature": "75"}', tool_call_id: "call_1" },
      ] as any,
    });
    const params = await invoke(context);

    expect(params.messages[1]!.content).toBe("Let me check on that.");
    expect(params.messages[1]!.reasoning_content).toBe("");
    expect(params.messages[2]!.reasoning_content).toBe("");
  });

  test("test_existing_reasoning_content_preserved", async () => {
    // An assistant message that already carries reasoning_content is left alone.
    const context = new LLMContext({
      messages: [
        { role: "user", content: "Weather in LA?" },
        {
          role: "assistant",
          tool_calls: [toolCall()],
          reasoning_content: "Need the weather tool.",
        },
      ] as any,
    });
    const params = await invoke(context);

    expect(params.messages[1]!.reasoning_content).toBe("Need the weather tool.");
  });

  test("test_non_assistant_messages_untouched", async () => {
    // System, user, and tool messages never get the field.
    const context = new LLMContext({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Weather in LA?" },
        { role: "assistant", tool_calls: [toolCall()] },
        { role: "tool", content: '{"temperature": "75"}', tool_call_id: "call_1" },
        { role: "user", content: "Thanks." },
      ] as any,
    });
    const params = await invoke(context);

    for (const i of [0, 1, 3, 4]) {
      expect("reasoning_content" in params.messages[i]!).toBe(false);
    }
    expect(params.messages[2]!.reasoning_content).toBe("");
  });

  test("test_context_messages_not_mutated", async () => {
    // Stamping produces copies; the context's own message dicts are unchanged.
    const assistant: Record<string, unknown> = { role: "assistant", content: "Hi!" };
    const context = new LLMContext({
      messages: [{ role: "user", content: "Hello" }, assistant] as any,
    });
    const params = await invoke(context);

    expect(params.messages[1]!.reasoning_content).toBe("");
    expect("reasoning_content" in assistant).toBe(false);
    expect("reasoning_content" in (context.getMessages()[1] as any)).toBe(false);
  });
});
