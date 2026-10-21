// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_get_llm_invocation_params.py

/**
 * Unit tests for PerplexityLLMAdapter's getLlmInvocationParams().
 *
 * Porting note: this is the `TestPerplexityGetLLMInvocationParams` class of
 * upstream's tests/test_get_llm_invocation_params.py. The rest of that file
 * covers other providers' adapters, and its port belongs to
 * @pipedog/anthropic.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { PerplexityLLMAdapter } from "../src/perplexity_adapter.ts";

describe("TestPerplexityGetLLMInvocationParams", () => {
  // Perplexity doesn't support the "developer" role, so PerplexityLLMService
  // sets supportsDeveloperRole = false. Tests below pass
  // convertDeveloperToUser: true to match production behavior.

  let adapter: PerplexityLLMAdapter;

  beforeEach(() => {
    adapter = new PerplexityLLMAdapter();
  });

  async function invoke(messages: Record<string, unknown>[]) {
    const context = new LLMContext({ messages: messages as any });
    return adapter.getLlmInvocationParams(context, { convertDeveloperToUser: true });
  }

  test("test_standard_messages_pass_through", async () => {
    // Test that a valid [user, assistant, user] sequence passes through unchanged.
    const params = await invoke([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ]);

    expect(params.messages.length).toBe(3);
    expect(params.messages[0]!.role).toBe("user");
    expect(params.messages[0]!.content).toBe("Hello");
    expect(params.messages[1]!.role).toBe("assistant");
    expect(params.messages[1]!.content).toBe("Hi there!");
    expect(params.messages[2]!.role).toBe("user");
    expect(params.messages[2]!.content).toBe("How are you?");
  });

  test("test_initial_system_message_preserved", async () => {
    // Test that a valid [system, user, assistant, user] sequence passes through unchanged.
    const params = await invoke([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "Bye" },
    ]);

    expect(params.messages.length).toBe(4);
    expect(params.messages[0]!.role).toBe("system");
    expect(params.messages[0]!.content).toBe("You are a helpful assistant.");
    expect(params.messages[1]!.role).toBe("user");
    expect(params.messages[2]!.role).toBe("assistant");
    expect(params.messages[3]!.role).toBe("user");
  });

  test("test_consecutive_same_role_messages_merged", async () => {
    // Test that consecutive user messages are merged into list-of-dicts content.
    const params = await invoke([
      { role: "user", content: "First message" },
      { role: "user", content: "Second message" },
      { role: "assistant", content: "Response" },
      { role: "user", content: "Third message" },
    ]);

    expect(params.messages.length).toBe(3);

    // First message should be merged users
    const merged = params.messages[0]!;
    expect(merged.role).toBe("user");
    expect(Array.isArray(merged.content)).toBe(true);
    expect(merged.content.length).toBe(2);
    expect(merged.content[0].type).toBe("text");
    expect(merged.content[0].text).toBe("First message");
    expect(merged.content[1].type).toBe("text");
    expect(merged.content[1].text).toBe("Second message");

    expect(params.messages[1]!.role).toBe("assistant");
    expect(params.messages[2]!.role).toBe("user");
  });

  test("test_non_initial_system_converted_to_user", async () => {
    // Test that non-initial system messages are converted to user and merged with adjacent user.
    const params = await invoke([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "system", content: "Be concise." },
      { role: "user", content: "Tell me about Python." },
    ]);

    // system(initial), user, assistant, merged(system→user + user)
    expect(params.messages.length).toBe(4);
    expect(params.messages[0]!.role).toBe("system");
    expect(params.messages[1]!.role).toBe("user");
    expect(params.messages[2]!.role).toBe("assistant");

    // The converted system→user and the following user should be merged
    const merged = params.messages[3]!;
    expect(merged.role).toBe("user");
    expect(Array.isArray(merged.content)).toBe(true);
    expect(merged.content.length).toBe(2);
    expect(merged.content[0].text).toBe("Be concise.");
    expect(merged.content[1].text).toBe("Tell me about Python.");
  });

  test("test_multiple_system_messages_at_start_preserved", async () => {
    // Test that multiple consecutive system messages at start pass through unchanged.
    const params = await invoke([
      { role: "system", content: "You are a helpful assistant." },
      { role: "system", content: "Always be polite." },
      { role: "user", content: "Hello" },
    ]);

    expect(params.messages.length).toBe(3);
    expect(params.messages[0]!.role).toBe("system");
    expect(params.messages[0]!.content).toBe("You are a helpful assistant.");
    expect(params.messages[1]!.role).toBe("system");
    expect(params.messages[1]!.content).toBe("Always be polite.");
    expect(params.messages[2]!.role).toBe("user");
    expect(params.messages[2]!.content).toBe("Hello");
  });

  test("test_trailing_assistant_removed", async () => {
    // Test that a trailing assistant message is removed.
    const params = await invoke([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);

    expect(params.messages.length).toBe(1);
    expect(params.messages[0]!.role).toBe("user");
    expect(params.messages[0]!.content).toBe("Hello");
  });

  test("test_only_system_messages_preserved", async () => {
    // Test that system-only contexts are left unchanged (no system→user conversion).
    //
    // We intentionally do not convert trailing system messages to "user"
    // because that would make the transformation unstable across calls:
    // Perplexity has statefulness within a conversation, so a message that
    // was "user" in one call but becomes "system" in the next causes errors.
    const params = await invoke([{ role: "system", content: "You are a helpful assistant." }]);

    expect(params.messages.length).toBe(1);
    expect(params.messages[0]!.role).toBe("system");
  });

  test("test_system_exposed_after_trailing_assistant_removed", async () => {
    // Test that a system message exposed by trailing assistant removal stays system.
    //
    // It's important that initial system messages are never converted to
    // "user", because Perplexity has statefulness within a conversation: if a
    // message was sent as "system" in one call and then becomes "user" in a
    // later call (after more messages are appended), the API rejects it.
    const params = await invoke([
      { role: "system", content: "You are helpful." },
      { role: "assistant", content: "Sure thing." },
    ]);

    // Trailing assistant removed → [system], system stays as-is
    expect(params.messages.length).toBe(1);
    expect(params.messages[0]!.role).toBe("system");
    expect(params.messages[0]!.content).toBe("You are helpful.");
  });

  test("test_consecutive_assistants_merged_then_trailing_removed", async () => {
    // Test that consecutive assistant messages are merged, then trailing assistant is removed.
    const params = await invoke([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "First response" },
      { role: "assistant", content: "Second response" },
    ]);

    // After merging assistants we get [user, assistant(merged)], then trailing
    // assistant is removed, leaving just [user]
    expect(params.messages.length).toBe(1);
    expect(params.messages[0]!.role).toBe("user");
    expect(params.messages[0]!.content).toBe("Hello");
  });

  test("test_tool_messages_preserved", async () => {
    // Test that tool messages pass through without modification.
    const params = await invoke([
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "1", function: { name: "get_weather", arguments: "{}" } }],
      },
      { role: "tool", content: "Sunny, 72F", tool_call_id: "1" },
      { role: "user", content: "Thanks!" },
    ]);

    expect(params.messages.length).toBe(4);
    expect(params.messages[0]!.role).toBe("user");
    expect(params.messages[1]!.role).toBe("assistant");
    expect(params.messages[2]!.role).toBe("tool");
    expect(params.messages[2]!.content).toBe("Sunny, 72F");
    expect(params.messages[3]!.role).toBe("user");
  });

  test("test_developer_message_converted_to_user", async () => {
    // Developer messages are converted to user role.
    const params = await invoke([
      { role: "developer", content: "Extra context." },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Hello" },
    ]);

    expect(params.messages[0]!.role).toBe("user");
    expect(params.messages[0]!.content).toBe("Extra context.");
  });

  test("test_developer_message_merged_with_adjacent_user", async () => {
    // Developer→user conversion merges with adjacent user messages.
    const params = await invoke([
      { role: "developer", content: "Be concise." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Bye" },
    ]);

    // developer→user merged with following user
    expect(params.messages.length).toBe(3);
    const merged = params.messages[0]!;
    expect(merged.role).toBe("user");
    expect(Array.isArray(merged.content)).toBe(true);
    expect(merged.content.length).toBe(2);
    expect(merged.content[0].text).toBe("Be concise.");
    expect(merged.content[1].text).toBe("Hello");
  });

  test("test_empty_messages", async () => {
    // Test that empty messages list returns empty.
    const params = await invoke([]);

    expect(params.messages).toEqual([]);
  });
});
