// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_token_usage.py

/** Tests for the token usage reported by GoogleLLMService. */

import { expect, mock, test } from "bun:test";

import { GenerateContentResponse } from "@google/genai";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { GoogleLLMService } from "../src/llm.ts";

function response(fields: Partial<GenerateContentResponse>): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), fields);
}

/** Stream canned chunks through the service and return the usage it reported. */
async function reportedUsage(...chunks: GenerateContentResponse[]): Promise<LLMTokenUsage> {
  const service = new GoogleLLMService({ apiKey: "test-key" });
  const startLlmUsageMetrics = mock(async (_usage: LLMTokenUsage) => {});
  (service as any).startLlmUsageMetrics = startLlmUsageMetrics;

  async function* generator() {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  (service as any)._streamContent = async (_context: LLMContext) => generator();
  (service as any).pushFrame = async (_frame: unknown, _direction?: unknown) => {};

  await (service as any)._processContext(new LLMContext());

  expect(startLlmUsageMetrics).toHaveBeenCalledTimes(1);
  return startLlmUsageMetrics.mock.calls[0]![0];
}

test("test_thinking_tokens_are_counted_as_completion_tokens", async () => {
  // Gemini counts thoughts apart from the candidates, and both are generated output.
  const usage = await reportedUsage(
    response({
      candidates: [{ content: { role: "model", parts: [{ text: "Hi!" }] } }],
      usageMetadata: {
        promptTokenCount: 40,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 120,
        totalTokenCount: 170,
      },
    }),
  );
  expect(usage.completionTokens).toBe(130);
  expect(usage.reasoningTokens).toBe(120);
  expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
});

test("test_tool_results_are_counted_as_prompt_tokens", async () => {
  // Code execution, URL context and search results fed back to the model are input.
  const usage = await reportedUsage(
    response({
      candidates: [{ content: { role: "model", parts: [{ text: "5117" }] } }],
      usageMetadata: {
        promptTokenCount: 23,
        candidatesTokenCount: 57,
        toolUsePromptTokenCount: 79,
        totalTokenCount: 159,
      },
    }),
  );
  expect(usage.promptTokens).toBe(102);
  expect(usage.completionTokens).toBe(57);
  expect(usage.totalTokens).toBe(159);
});
