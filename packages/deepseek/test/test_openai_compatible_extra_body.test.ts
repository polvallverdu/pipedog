// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_compatible_extra_body.py

/**
 * Provider-specific request fields that OpenAI-compatible services send in
 * `extra_body`.
 *
 * Porting notes:
 * - `patch.object(cls, "create_client")` → `spyOn` on the prototype's
 *   `createClient`, restored right after construction.
 * - The other providers' services are imported from their packages' sources
 *   in this workspace.
 * - Pydantic's keyword arguments are camelCase options here:
 *   `ProviderPreferences(preferred_max_latency=...)` →
 *   `new ProviderPreferences({ preferredMaxLatency: ... })`.
 */

import { expect, spyOn, test } from "bun:test";
import {
  OPENAI_NOT_GIVEN,
  type OpenAILLMInvocationParams,
} from "@pipedog/core/adapters/services/open_ai_adapter";
import { NOT_GIVEN } from "@pipedog/core/utils/types";
import { BaseOpenAILLMService } from "@pipedog/openai/base_llm";
import { OpenRouterLLMService } from "../../openrouter/src/llm.ts";
import { TogetherLLMService } from "../../together/src/llm.ts";
import { GrokLLMService } from "../../xai/src/llm.ts";
import { DeepSeekLLMService } from "../src/llm.ts";

function invocation(): OpenAILLMInvocationParams {
  return {
    messages: [{ role: "user", content: "Hello" }],
    tools: OPENAI_NOT_GIVEN,
    tool_choice: OPENAI_NOT_GIVEN,
  };
}

function construct<T>(serviceClass: { prototype: any }, build: () => T): T {
  const spy = spyOn(serviceClass.prototype, "createClient").mockImplementation(() => ({}) as any);
  try {
    return build();
  } finally {
    spy.mockRestore();
  }
}

function buildParams(
  serviceClass:
    | typeof DeepSeekLLMService
    | typeof OpenRouterLLMService
    | typeof TogetherLLMService
    | typeof GrokLLMService,
  settings: unknown = null,
): Record<string, any> {
  const service = construct(
    serviceClass,
    () => new (serviceClass as any)({ apiKey: "test-key", settings }),
  ) as BaseOpenAILLMService;
  return service.buildChatCompletionParams(invocation());
}

test("test_merge_extra_body_omits_unset_and_none", () => {
  let params: Record<string, any> = {};
  BaseOpenAILLMService._mergeExtraBody(params, { a: 1, b: null, c: NOT_GIVEN });
  expect(params).toEqual({ extra_body: { a: 1 } });

  params = {};
  BaseOpenAILLMService._mergeExtraBody(params, { a: null });
  expect("extra_body" in params).toBe(false);
});

test("test_merge_extra_body_user_wins_and_is_not_modified", () => {
  const userExtraBody = { a: "user", u: 1 };
  const params: Record<string, any> = { extra_body: userExtraBody };
  BaseOpenAILLMService._mergeExtraBody(params, { a: "service", s: 2 });

  expect(params.extra_body).toEqual({ a: "user", u: 1, s: 2 });
  expect(userExtraBody).toEqual({ a: "user", u: 1 });
});

test("test_together_reasoning_unset_by_default", () => {
  const params = buildParams(TogetherLLMService);
  expect("extra_body" in params).toBe(false);
});

test("test_together_reasoning_in_extra_body", () => {
  const params = buildParams(
    TogetherLLMService,
    new TogetherLLMService.Settings({
      reasoning: { enabled: false },
      extra: { extra_body: { user_field: 1 } },
    }),
  );
  expect("reasoning" in params).toBe(false);
  expect(params.extra_body).toEqual({ reasoning: { enabled: false }, user_field: 1 });
});

test("test_grok_reasoning_effort_unset_by_default", () => {
  const params = buildParams(GrokLLMService);
  expect("reasoning_effort" in params).toBe(false);
  expect("extra_body" in params).toBe(false);
});

test("test_grok_reasoning_effort_is_top_level", () => {
  const params = buildParams(
    GrokLLMService,
    new GrokLLMService.Settings({ reasoningEffort: "low" }),
  );
  expect(params.reasoning_effort).toBe("low");
  expect("extra_body" in params).toBe(false);
});

test("test_grok_settings_extra_reasoning_effort_wins", () => {
  const params = buildParams(
    GrokLLMService,
    new GrokLLMService.Settings({ reasoningEffort: "low", extra: { reasoning_effort: "high" } }),
  );
  expect(params.reasoning_effort).toBe("high");
});

test("test_deepseek_disables_thinking_by_default", () => {
  const params = buildParams(DeepSeekLLMService);
  expect(params.extra_body).toEqual({ thinking: { type: "disabled" } });
  expect("seed" in params).toBe(false);
  expect("max_completion_tokens" in params).toBe(false);
});

test("test_deepseek_thinking_none_leaves_default_to_deepseek", () => {
  const params = buildParams(
    DeepSeekLLMService,
    new DeepSeekLLMService.Settings({ thinking: null }),
  );
  expect("extra_body" in params).toBe(false);
});

test("test_deepseek_thinking_keeps_user_extra_body", () => {
  const params = buildParams(
    DeepSeekLLMService,
    new DeepSeekLLMService.Settings({
      thinking: new DeepSeekLLMService.ThinkingConfig({ type: "enabled" }),
      extra: { extra_body: { user_field: 1 } },
    }),
  );
  expect(params.extra_body).toEqual({ thinking: { type: "enabled" }, user_field: 1 });
});

test.todo("test_inception_realtime_keeps_user_extra_body: needs pipecat.services.inception.llm");
test.todo(
  "test_sarvam_wiki_grounding_does_not_modify_settings_extra: needs pipecat.services.sarvam.llm",
);
test.todo("test_sarvam_user_extra_body_wins: needs pipecat.services.sarvam.llm");

test("test_openrouter_provider_unset_by_default", () => {
  const params = buildParams(OpenRouterLLMService);
  expect("extra_body" in params).toBe(false);
});

test("test_openrouter_provider_preferences_in_extra_body", () => {
  const params = buildParams(
    OpenRouterLLMService,
    new OpenRouterLLMService.Settings({
      provider: new OpenRouterLLMService.ProviderPreferences({
        sort: "latency",
        preferredMaxLatency: { p90: 1.5 },
      }),
    }),
  );
  expect(params.extra_body).toEqual({
    provider: { sort: "latency", preferred_max_latency: { p90: 1.5 } },
  });
});

test("test_openrouter_provider_dict_in_extra_body", () => {
  const params = buildParams(
    OpenRouterLLMService,
    new OpenRouterLLMService.Settings({ provider: { only: ["azure"], allow_fallbacks: false } }),
  );
  expect(params.extra_body).toEqual({ provider: { only: ["azure"], allow_fallbacks: false } });
});

test("test_openrouter_provider_preferences_keep_unknown_options", () => {
  const params = buildParams(
    OpenRouterLLMService,
    new OpenRouterLLMService.Settings({
      provider: new OpenRouterLLMService.ProviderPreferences({ sort: "price", new_option: true }),
    }),
  );
  expect(params.extra_body).toEqual({ provider: { sort: "price", new_option: true } });
});

test("test_openrouter_user_extra_body_wins", () => {
  const params = buildParams(
    OpenRouterLLMService,
    new OpenRouterLLMService.Settings({
      provider: { only: ["azure"] },
      extra: { extra_body: { provider: { only: ["groq"] }, user_field: 1 } },
    }),
  );
  expect(params.extra_body).toEqual({ provider: { only: ["groq"] }, user_field: 1 });
});

test("test_openrouter_provider_dict_coerced_to_preferences", () => {
  const settings = new OpenRouterLLMService.Settings({ provider: { sort: "latency" } });
  expect(settings.provider).toEqual(
    new OpenRouterLLMService.ProviderPreferences({ sort: "latency" }),
  );
});

test("test_openrouter_provider_updates_at_runtime", async () => {
  const service: any = construct(
    OpenRouterLLMService,
    () =>
      new OpenRouterLLMService({
        apiKey: "test-key",
        settings: new OpenRouterLLMService.Settings({ provider: { only: ["azure"] } }),
      }),
  );

  const changed = await service._updateSettings(
    OpenRouterLLMService.Settings.fromMapping({ provider: { sort: "latency" } }),
  );
  expect("provider" in changed).toBe(true);
  let params = service.buildChatCompletionParams(invocation());
  expect(params.extra_body).toEqual({ provider: { sort: "latency" } });

  await service._updateSettings(new OpenRouterLLMService.Settings({ provider: null }));
  params = service.buildChatCompletionParams(invocation());
  expect("extra_body" in params).toBe(false);
});
