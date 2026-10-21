// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for OpenAI Responses adapter message rendering for logging.
 *
 * Reasoning items round-trip through the universal context as
 * `LLMSpecificMessage`s. `getMessagesForLogging()` must render them as
 * plain JSON-serializable dicts (the tracing decorator `JSON.stringify`s the
 * result) with the `encrypted_content` payload elided.
 */

import { expect, test } from "bun:test";
import {
  LLMContext,
  type LLMSpecificMessage,
} from "@pipedog/core/processors/aggregators/llm_context";
import { OpenAIResponsesLLMAdapter } from "../src/open_ai_responses_adapter.ts";

const REASONING_MESSAGE = {
  type: "reasoning",
  id: "rs_123",
  summary: [{ type: "summary_text", text: "thinking about the weather" }],
  encrypted_content: "gAAAA".repeat(300),
};

function adapterAndContext(): [OpenAIResponsesLLMAdapter, LLMContext] {
  const adapter = new OpenAIResponsesLLMAdapter();
  const context = new LLMContext({
    messages: [
      { role: "user", content: "hello" },
      adapter.createLlmSpecificMessage({ ...REASONING_MESSAGE }),
      { role: "assistant", content: "hi" },
    ],
  });
  return [adapter, context];
}

test("test_reasoning_encrypted_content_is_elided", () => {
  const [adapter, context] = adapterAndContext();
  const messages = adapter.getMessagesForLogging(context);
  expect(messages.length).toBe(3);
  const reasoning = messages[1]!;
  expect(reasoning.type).toBe("reasoning");
  expect(reasoning.id).toBe("rs_123");
  expect(reasoning.summary).toEqual(REASONING_MESSAGE.summary);
  expect(reasoning.encrypted_content).toBe("...");
});

test("test_messages_for_logging_are_json_serializable", () => {
  // The tracing decorator JSON-serializes the result for the LLM span's
  // input attribute, so every rendered message must be JSON-serializable.
  const [adapter, context] = adapterAndContext();
  JSON.stringify(adapter.getMessagesForLogging(context));
});

test("test_standard_messages_pass_through", () => {
  const [adapter, context] = adapterAndContext();
  const messages = adapter.getMessagesForLogging(context);
  expect(messages[0]).toEqual({ role: "user", content: "hello" });
  expect(messages[2]).toEqual({ role: "assistant", content: "hi" });
});

test("test_context_not_mutated_by_elision", () => {
  const [adapter, context] = adapterAndContext();
  adapter.getMessagesForLogging(context);
  const stored = context.getMessages("openai_responses")[1] as LLMSpecificMessage;
  expect((stored.message as Record<string, unknown>).encrypted_content).toBe(
    REASONING_MESSAGE.encrypted_content,
  );
});

test("test_reasoning_without_encrypted_content_is_untouched", () => {
  const adapter = new OpenAIResponsesLLMAdapter();
  const context = new LLMContext({
    messages: [adapter.createLlmSpecificMessage({ type: "reasoning", id: "rs_9", summary: [] })],
  });
  const messages = adapter.getMessagesForLogging(context);
  expect(messages[0]).toEqual({ type: "reasoning", id: "rs_9", summary: [] });
  JSON.stringify(messages);
});
