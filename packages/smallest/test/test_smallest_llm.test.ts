// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_smallest_llm.py

/**
 * Unit tests for Smallest AI LLM service.
 *
 * Porting notes:
 * - `patch.object(SmallestLLMService, "create_client")` → `spyOn` on the
 *   prototype's `createClient`, restored after each test.
 * - `mock_create_client.call_args.kwargs["base_url"]` → the `baseUrl` field of
 *   the options object passed to the spied `createClient`.
 * - The OpenAI SDK's `NOT_GIVEN` is `undefined` in the JS SDK.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { OPENAI_NOT_GIVEN } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { OpenAILLMSettingsOptions } from "@pipedog/openai/base_llm";
import { SmallestLLMService } from "../src/llm.ts";

let createClientSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  createClientSpy = spyOn(SmallestLLMService.prototype, "createClient").mockImplementation(
    () => ({}) as any,
  );
});

afterEach(() => {
  createClientSpy?.mockRestore();
  createClientSpy = null;
});

/** Build a SmallestLLMService without opening a client connection. */
function serviceFactory(settings?: OpenAILLMSettingsOptions): SmallestLLMService {
  return new SmallestLLMService({
    apiKey: "test-key",
    settings:
      settings && Object.keys(settings).length > 0
        ? new SmallestLLMService.Settings(settings)
        : null,
  });
}

test("test_default_model_is_electron", () => {
  // Electron is Smallest AI's LLM and the service's default model.
  const service = serviceFactory();

  const params = service.buildChatCompletionParams({} as any);

  expect(params.model).toBe("electron");
});

test("test_base_url_defaults_to_waves_api", () => {
  // The service should point at Smallest AI's Waves API by default.
  new SmallestLLMService({ apiKey: "test-key" });

  const callArgs = createClientSpy!.mock.calls.at(-1)!;
  expect((callArgs[0] as any).baseUrl).toBe("https://api.smallest.ai/waves/v1");
});

test("test_model_can_be_overridden", () => {
  // Callers can select a different OpenAI-compatible model via settings.
  const service = serviceFactory({ model: "some-other-model" });

  const params = service.buildChatCompletionParams({} as any);

  expect(params.model).toBe("some-other-model");
});

test("test_temperature_reaches_the_request", () => {
  // Standard OpenAI-compatible params pass through untouched.
  const service = serviceFactory({ temperature: 0.3 });

  const params = service.buildChatCompletionParams({} as any);

  expect(params.temperature).toBe(0.3);
});

test("test_unset_params_are_omitted", () => {
  // Unset fields carry the OpenAI sentinel so the SDK keeps them off the wire.
  const service = serviceFactory();

  const params = service.buildChatCompletionParams({} as any);

  expect(params.max_tokens).toBe(OPENAI_NOT_GIVEN);
  expect(params.frequency_penalty).toBe(OPENAI_NOT_GIVEN);
});

test("test_developer_messages_are_converted_to_user", async () => {
  // Electron doesn't support the "developer" role, so it's sent as "user".
  const service = serviceFactory();
  const context = new LLMContext({
    messages: [
      { role: "developer", content: "Be terse." },
      { role: "user", content: "Hello" },
    ],
  });

  const params = await service.getLlmAdapter().getLlmInvocationParams(context, {
    convertDeveloperToUser: !service.supportsDeveloperRole,
  });

  expect(params.messages[0]!.role).toBe("user");
});
