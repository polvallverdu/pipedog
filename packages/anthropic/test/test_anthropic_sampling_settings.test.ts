// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_anthropic_sampling_settings.py

/**
 * Tests for how AnthropicLLMService sends temperature, top_k and top_p.
 *
 * The Messages API methods have no parameters for them, so the service carries
 * them in `extra_body`, which the SDK merges into the request JSON as-is.
 *
 * Porting note: the JS SDK has no `extra_body` option, so the service merges
 * `extra_body` into the request JSON itself right before calling the client.
 * The request kwargs upstream inspects on the SDK call are therefore read here
 * from the final request params, captured just before that merge.
 */

import { expect, mock, spyOn, test } from "bun:test";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { AnthropicLLMService, type AnthropicLLMSettingsOptions } from "../src/llm.ts";

/** Return the kwargs run_inference sends for a service with these settings. */
async function _requestKwargs(
  settings: AnthropicLLMSettingsOptions = {},
): Promise<Record<string, unknown>> {
  const create = mock(async () => ({ content: [] }));
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings(settings),
    client: { beta: { messages: { create } } },
  });
  // The last step before the request is sent; it receives the final params.
  const finalParams = spyOn(service as any, "_maybeApplyThinkingDefault");

  await service.runInference(new LLMContext({ messages: [{ role: "user", content: "hi" }] }));

  expect(create).toHaveBeenCalledTimes(1);
  return finalParams.mock.calls[0]![0] as Record<string, unknown>;
}

test("test_sampling_settings_are_sent_in_extra_body", async () => {
  const kwargs = await _requestKwargs({ temperature: 0.6, topK: 50, topP: 0.95 });

  expect(kwargs.extra_body).toEqual({ temperature: 0.6, top_k: 50, top_p: 0.95 });
  for (const name of ["temperature", "top_k", "top_p"]) {
    expect(name in kwargs).toBe(false);
  }
});

test("test_unset_sampling_settings_are_omitted", async () => {
  const kwargs = await _requestKwargs({ temperature: 0.6 });

  expect(kwargs.extra_body).toEqual({ temperature: 0.6 });
});

test("test_no_extra_body_when_no_sampling_settings", async () => {
  const kwargs = await _requestKwargs();

  expect("extra_body" in kwargs).toBe(false);
});

// DIVERGENCE: the port uses `null` in place of the Anthropic SDK's NOT_GIVEN
// for the sampling settings (see the porting notes in src/llm.ts), so an
// explicit null is omitted instead of being sent as JSON null.
test.skip("test_explicit_none_is_sent", async () => {
  // A None reaches the API as JSON null rather than being dropped.
  const kwargs = await _requestKwargs({ temperature: null });

  expect(kwargs.extra_body).toEqual({ temperature: null });
});

test("test_extra_body_from_extra_wins_per_key", async () => {
  const kwargs = await _requestKwargs({
    temperature: 0.6,
    topK: 50,
    extra: { extra_body: { temperature: 0.1 } },
  });

  expect(kwargs.extra_body).toEqual({ temperature: 0.1, top_k: 50 });
});
