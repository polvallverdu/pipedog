// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_mistral_llm.py

/**
 * Unit tests for the Mistral LLM service's request parameters.
 *
 * Porting note: `patch.object(MistralLLMService, "create_client")` → `spyOn`
 * on the prototype's `createClient`, restored after construction.
 */

import { expect, spyOn, test } from "bun:test";
import { OPENAI_NOT_GIVEN } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { MistralLLMService, type MistralLLMSettings } from "../src/llm.ts";

function buildParams(settings: MistralLLMSettings | null = null): Record<string, any> {
  const spy = spyOn(MistralLLMService.prototype, "createClient").mockImplementation(
    () => ({}) as any,
  );
  const service = new MistralLLMService({ apiKey: "test-key", settings });
  spy.mockRestore();
  return service.buildChatCompletionParams({
    messages: [{ role: "user", content: "Hello" }],
    tools: OPENAI_NOT_GIVEN,
    tool_choice: OPENAI_NOT_GIVEN,
  });
}

test.each([[0], [42]])("test_seed_is_sent_as_random_seed[%p]", (seed) => {
  const params = buildParams(new MistralLLMService.Settings({ seed }));

  expect(params.random_seed).toBe(seed);
});

test("test_unset_seed_is_not_sent", () => {
  const params = buildParams();

  expect("random_seed" in params).toBe(false);
});
