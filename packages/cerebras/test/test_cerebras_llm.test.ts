// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_cerebras_llm.py

/**
 * Unit tests for Cerebras LLM service.
 *
 * Porting notes:
 * - `patch.object(CerebrasLLMService, "create_client")` → `spyOn` on the
 *   prototype's `createClient`, restored after each test.
 * - The OpenAI SDK's `NOT_GIVEN` is `undefined` in the JS SDK.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { OPENAI_NOT_GIVEN } from "@pipedog/core/adapters/services/open_ai_adapter";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { OpenAILLMSettingsOptions } from "@pipedog/openai/base_llm";
import { CerebrasLLMService } from "../src/llm.ts";

let createClientSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  createClientSpy = spyOn(CerebrasLLMService.prototype, "createClient").mockImplementation(
    () => ({}) as any,
  );
});

afterEach(() => {
  createClientSpy?.mockRestore();
  createClientSpy = null;
});

/** Build a CerebrasLLMService without opening a client connection. */
function serviceFactory(settings: OpenAILLMSettingsOptions): CerebrasLLMService {
  return new CerebrasLLMService({
    apiKey: "test-key",
    settings: new CerebrasLLMService.Settings(settings),
  });
}

test("test_max_tokens_reaches_the_request", () => {
  // Cerebras accepts and honors `max_tokens`, so it must not be dropped.
  const service = serviceFactory({ model: "gpt-oss-120b", maxTokens: 200 });

  const params = service.buildChatCompletionParams({} as any);

  expect(params.max_tokens).toBe(200);
});

test("test_max_completion_tokens_reaches_the_request", () => {
  // `max_completion_tokens` is the documented spelling and must survive too.
  const service = serviceFactory({ model: "gpt-oss-120b", maxCompletionTokens: 200 });

  const params = service.buildChatCompletionParams({} as any);

  expect(params.max_completion_tokens).toBe(200);
});

test("test_penalties_reach_the_request", () => {
  // Cerebras supports frequency and presence penalties.
  const service = serviceFactory({
    model: "gpt-oss-120b",
    frequencyPenalty: 0.5,
    presencePenalty: -0.5,
  });

  const params = service.buildChatCompletionParams({} as any);

  expect(params.frequency_penalty).toBe(0.5);
  expect(params.presence_penalty).toBe(-0.5);
});

test("test_unset_params_are_omitted", () => {
  // Unset fields carry the OpenAI sentinel so the SDK keeps them off the wire.
  const service = serviceFactory({ model: "gpt-oss-120b" });

  const params = service.buildChatCompletionParams({} as any);

  expect(params.max_tokens).toBe(OPENAI_NOT_GIVEN);
  expect(params.max_completion_tokens).toBe(OPENAI_NOT_GIVEN);
  expect(params.frequency_penalty).toBe(OPENAI_NOT_GIVEN);
});

test("test_extra_passes_provider_specific_params", () => {
  // `extra` carries Cerebras-only params such as `reasoning_effort`.
  const service = serviceFactory({ model: "gpt-oss-120b", extra: { reasoning_effort: "low" } });

  const params = service.buildChatCompletionParams({} as any);

  expect(params.reasoning_effort).toBe("low");
});

test("test_developer_messages_are_sent_as_is", async () => {
  // Cerebras maps the "developer" role to its developer instruction layer.
  const service = serviceFactory({ model: "gpt-oss-120b" });
  const context = new LLMContext({
    messages: [
      { role: "developer", content: "Be terse." },
      { role: "user", content: "Hello" },
    ],
  });

  const params = await service.getLlmAdapter().getLlmInvocationParams(context, {
    convertDeveloperToUser: !service.supportsDeveloperRole,
  });

  expect(params.messages[0]!.role).toBe("developer");
});
