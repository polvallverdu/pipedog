// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_reasoning_token_usage.py

/**
 * Tests that LLM services count reasoning tokens as completion tokens.
 *
 * Pipecat reports every generated token in `completion_tokens` and the part
 * spent on reasoning in `reasoning_tokens`, whichever way a provider reports
 * them.
 *
 * PORTING NOTES:
 * - `OpenAILLMService`, `GrokLLMService` and `GeminiLiveLLMService` are
 *   imported by relative path from `@pipedog/openai`, `@pipedog/xai` and
 *   `@pipedog/google`, which this package does not depend on.
 * - Provider SDK models (`CompletionUsage`, `UsageMetadata`, `BetaUsage`, ...)
 *   are built as plain objects; fields pydantic would default are `null`.
 *   Gemini fields use the JS SDK's camelCase names.
 * - `patch.object(service, name, fake)` → the fake is assigned on the instance.
 */

import { expect, mock, test } from "bun:test";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { GeminiLiveLLMService } from "../../google/src/gemini_live/llm.ts";
import { OpenAILLMService } from "../../openai/src/llm.ts";
import { GrokLLMService } from "../../xai/src/llm.ts";
import { AnthropicLLMService } from "../src/llm.ts";

type Internals = any;

function _usage(fields: Record<string, unknown>): Internals {
  return {
    completion_tokens_details: null,
    prompt_tokens_details: null,
    ...fields,
  };
}

// -- OpenAI-compatible ------------------------------------------------------

test("test_openai_reasoning_is_part_of_completion_tokens", () => {
  const service = new OpenAILLMService({ apiKey: "test-key" }) as Internals;
  const tokens: LLMTokenUsage = service._tokenUsage(
    _usage({
      prompt_tokens: 40,
      completion_tokens: 130,
      total_tokens: 170,
      completion_tokens_details: { reasoning_tokens: 120 },
    }),
  );
  expect(tokens.completionTokens).toBe(130);
  expect(tokens.reasoningTokens).toBe(120);
});

test("test_grok_adds_reasoning_reported_apart_from_completion_tokens", () => {
  const service = new GrokLLMService({ apiKey: "test-key" }) as Internals;
  const tokens: LLMTokenUsage = service._tokenUsage(
    _usage({
      prompt_tokens: 32,
      completion_tokens: 9,
      total_tokens: 135,
      completion_tokens_details: { reasoning_tokens: 94 },
    }),
  );
  expect(tokens.completionTokens).toBe(103);
  expect(tokens.reasoningTokens).toBe(94);
  expect(tokens.totalTokens).toBe(135);
});

test("test_grok_keeps_reasoning_already_in_completion_tokens", () => {
  const service = new GrokLLMService({ apiKey: "test-key" }) as Internals;
  const tokens: LLMTokenUsage = service._tokenUsage(
    _usage({
      prompt_tokens: 32,
      completion_tokens: 103,
      total_tokens: 135,
      completion_tokens_details: { reasoning_tokens: 94 },
    }),
  );
  expect(tokens.completionTokens).toBe(103);
});

// -- Gemini Live ------------------------------------------------------------

test("test_gemini_live_adds_thoughts_to_completion_tokens", async () => {
  const service = new GeminiLiveLLMService({ apiKey: "test-key" }) as Internals;
  service.startLlmUsageMetrics = mock(async () => {});

  await service._handleMsgUsageMetadata({
    usageMetadata: {
      promptTokenCount: 40,
      responseTokenCount: 10,
      thoughtsTokenCount: 120,
      totalTokenCount: 170,
    },
  });

  const tokens: LLMTokenUsage = service.startLlmUsageMetrics.mock.lastCall[0];
  expect(tokens.completionTokens).toBe(130);
  expect(tokens.reasoningTokens).toBe(120);
  expect(tokens.totalTokens).toBe(170);
});

test("test_gemini_live_computes_the_total_from_input_and_output", async () => {
  // Gemini Live's own total sometimes leaves the thinking tokens out.
  const service = new GeminiLiveLLMService({ apiKey: "test-key" }) as Internals;
  service.startLlmUsageMetrics = mock(async () => {});

  await service._handleMsgUsageMetadata({
    usageMetadata: {
      promptTokenCount: 2921,
      responseTokenCount: 41,
      thoughtsTokenCount: 176,
      toolUsePromptTokenCount: 33,
      totalTokenCount: 2962,
    },
  });

  const tokens: LLMTokenUsage = service.startLlmUsageMetrics.mock.lastCall[0];
  expect(tokens.promptTokens).toBe(2954);
  expect(tokens.completionTokens).toBe(217);
  expect(tokens.totalTokens).toBe(3171);
});

// -- Anthropic --------------------------------------------------------------

/** Stream canned events through the service and return the usage it reported. */
async function _anthropicReportedUsage(...events: unknown[]): Promise<LLMTokenUsage> {
  const service = new AnthropicLLMService({ apiKey: "test-key" }) as Internals;
  const startLlmUsageMetrics = mock(async (_tokens: LLMTokenUsage) => {});
  service.startLlmUsageMetrics = startLlmUsageMetrics;

  async function* generator() {
    for (const event of events) {
      yield event;
    }
  }

  service.pushFrame = async (_frame: unknown, _direction?: unknown) => {};
  service._createMessageStream = async (_apiCall: unknown, _params: unknown) => generator();

  await service._processContext(new LLMContext());

  return startLlmUsageMetrics.mock.lastCall![0];
}

function _betaUsage(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    input_tokens: null,
    output_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    output_tokens_details: null,
    ...fields,
  };
}

function _messageStart(usage: Record<string, unknown>) {
  return { type: "message_start", message: { usage } };
}

function _messageDelta(usage: Record<string, unknown>) {
  return { type: "message_delta", delta: { stop_reason: "end_turn" }, usage };
}

test("test_anthropic_reports_thinking_tokens_from_the_final_usage", async () => {
  // message_delta counts are cumulative, so they replace message_start's.
  const tokens = await _anthropicReportedUsage(
    _messageStart(
      _betaUsage({
        input_tokens: 40,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
      }),
    ),
    _messageDelta(
      _betaUsage({
        input_tokens: 40,
        output_tokens: 130,
        cache_read_input_tokens: 100,
        output_tokens_details: { thinking_tokens: 120 },
      }),
    ),
  );
  expect(tokens.promptTokens).toBe(40);
  expect(tokens.completionTokens).toBe(130);
  expect(tokens.reasoningTokens).toBe(120);
  expect(tokens.cacheReadInputTokens).toBe(100);
  expect(tokens.totalTokens).toBe(270);
});

test("test_anthropic_keeps_input_counts_a_message_delta_leaves_out", async () => {
  const tokens = await _anthropicReportedUsage(
    _messageStart(_betaUsage({ input_tokens: 40, output_tokens: 2, cache_read_input_tokens: 100 })),
    _messageDelta(_betaUsage({ output_tokens: 15 })),
  );
  expect(tokens.promptTokens).toBe(40);
  expect(tokens.completionTokens).toBe(15);
  expect(tokens.cacheReadInputTokens).toBe(100);
  expect(tokens.reasoningTokens).toBeNull();
});
