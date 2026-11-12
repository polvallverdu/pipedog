// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_sarvam_llm.py

/**
 * Tests for SarvamLLMService.
 *
 * Porting notes:
 * - `patch.object(SarvamLLMService, "create_client")` → `spyOn` on the
 *   prototype's `createClient`, restored right after construction. The base
 *   class's `createClient` is spied on `OpenAILLMService.prototype`, which is
 *   what `super.createClient()` reaches.
 * - DIVERGENCE: the Python SDK takes `extra_body` as a keyword and merges it
 *   into the request on the wire, so upstream asserts on
 *   `call_kwargs["extra_body"]`. Here the service flattens `extra_body` into
 *   the request body itself (`_requestBody`), so the client mock sees
 *   `wiki_grounding` at the top level and no `extra_body` key.
 * - `_FakeSarvamError(body)` keeps its `body` attribute.
 * - `_contains_pipecat_not_given` also treats `undefined` (the OpenAI SDK's
 *   not-given value in this port) as not given.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";
import { CancelledError, TimeoutError } from "@pipedog/asyncio";
import {
  OPENAI_NOT_GIVEN,
  type OpenAILLMInvocationParams,
} from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { LLMContextFrame } from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { NotGiven } from "@pipedog/core/utils/types";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { sdkHeaders } from "../src/_sdk.ts";
import { SarvamLLMService } from "../src/llm.ts";

type Any = any;

function mockAdapter(invocation?: OpenAILLMInvocationParams): Any {
  // Adapter mock with an async getLlmInvocationParams.
  return {
    getLlmInvocationParams: mock(async () => invocation),
    getMessagesForLogging: mock(() => []),
  };
}

class FakeSarvamError extends Error {
  body: unknown;
  constructor(body: unknown) {
    super("Request failed");
    this.body = body;
  }
}

class FakeSarvamResponseError extends Error {}

function containsPipecatNotGiven(value: unknown): boolean {
  if (value instanceof NotGiven) return true;
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(containsPipecatNotGiven);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsPipecatNotGiven);
  }
  return false;
}

function invocation(overrides: Partial<OpenAILLMInvocationParams> = {}): OpenAILLMInvocationParams {
  return {
    messages: [{ role: "user", content: "Hello" }],
    tools: OPENAI_NOT_GIVEN,
    tool_choice: OPENAI_NOT_GIVEN,
    ...overrides,
  } as OpenAILLMInvocationParams;
}

/** Construct a service with `createClient` stubbed (patch.object(cls, "create_client")). */
function make(settings?: Any, extra: Record<string, unknown> = {}): Any {
  const spy = spyOn(SarvamLLMService.prototype, "createClient").mockImplementation(
    () => ({}) as Any,
  );
  try {
    return new SarvamLLMService({
      apiKey: "test-key",
      settings: settings ? new SarvamLLMService.Settings(settings) : null,
      ...extra,
    });
  } finally {
    spy.mockRestore();
  }
}

/** Construct a service while recording what the base `createClient` receives. */
function makeRecording(
  settings?: Any,
  extra: Record<string, unknown> = {},
): { calls: Any[][]; service: Any } {
  const spy = spyOn(OpenAILLMService.prototype, "createClient").mockImplementation(
    () => ({}) as Any,
  );
  try {
    const service = new SarvamLLMService({
      apiKey: "test-key",
      settings: settings ? new SarvamLLMService.Settings(settings) : null,
      ...extra,
    });
    return { calls: spy.mock.calls as Any[][], service };
  } finally {
    spy.mockRestore();
  }
}

/** A mocked `client.chat.completions.create`. */
function mockClient(impl: (...args: Any[]) => Any = async () => undefined): Any {
  return { chat: { completions: { create: mock(impl) } } };
}

function withErrors(service: Any): string[] {
  const pushed: string[] = [];
  service.pushError = async (errorMsg: string) => {
    pushed.push(errorMsg);
  };
  return pushed;
}

function completion(content: string): Any {
  return { choices: [{ message: { content } }] };
}

const IMAGE_MESSAGES = [
  {
    role: "user",
    content: [
      { type: "text", text: "Describe this image." },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo...", detail: "auto" },
      },
    ],
  },
];

test("test_sarvam_llm_constructor_rejects_unsupported_model", () => {
  expect(() => make({ model: "sarvam-100b" })).toThrow("Unsupported Sarvam LLM model");
});

describe("test_sarvam_llm_constructor_accepts_supported_models", () => {
  for (const model of [
    "deepseekv4.1-flash",
    "gemma4",
    "glm5.3",
    "sarvam-105b",
    "sarvam-105b-conversations",
  ]) {
    test(model, () => {
      const service = make({ model });
      expect(service._settings.model).toBe(model);
    });
  }
});

test("test_sarvam_llm_default_model_is_sarvam_105b", () => {
  const service = make();
  expect(service._settings.model).toBe("sarvam-105b");
});

describe("test_sarvam_llm_default_base_url_resolved_per_model", () => {
  for (const [model, expected] of [
    ["sarvam-105b", "https://api.sarvam.ai/v2"],
    ["deepseekv4.1-flash", "https://api.sarvam.ai/v2"],
    ["gemma4", "https://api.sarvam.ai/v2"],
    ["glm5.3", "https://api.sarvam.ai/v2"],
    ["sarvam-105b-conversations", "https://api.sarvam.ai/v1"],
  ] as const) {
    test(model, () => {
      const { calls } = makeRecording({ model });
      expect(calls[0]![0].baseUrl).toBe(expected);
    });
  }
});

test("test_sarvam_llm_explicit_base_url_overrides_model_default", () => {
  const { calls } = makeRecording(
    { model: "sarvam-105b-conversations" },
    { baseUrl: "https://custom.example.com/v3" },
  );
  expect(calls[0]![0].baseUrl).toBe("https://custom.example.com/v3");
});

test("test_sarvam_llm_create_client_injects_required_headers", () => {
  const { calls } = makeRecording({ model: "sarvam-105b" });

  const headers = calls[0]![0].defaultHeaders;
  expect(headers["api-subscription-key"]).toBe("test-key");
  expect(headers["User-Agent"]).toBe(sdkHeaders()["User-Agent"]);
});

describe("test_sarvam_llm_reasoning_effort_passed_to_request", () => {
  for (const reasoningEffort of ["low", "medium", "high"]) {
    test(reasoningEffort, () => {
      const service = make({ model: "sarvam-105b", reasoningEffort });

      const builtParams = service.buildChatCompletionParams(invocation());
      expect(builtParams.reasoning_effort).toBe(reasoningEffort);
    });
  }
});

test("test_sarvam_llm_create_client_merges_default_headers", () => {
  const { calls } = makeRecording(
    { model: "sarvam-105b" },
    { defaultHeaders: { "X-Test-Header": "enabled", "User-Agent": "custom-agent" } },
  );

  const headers = calls[0]![0].defaultHeaders;
  expect(headers["X-Test-Header"]).toBe("enabled");
  expect(headers["api-subscription-key"]).toBe("test-key");
  expect(headers["User-Agent"]).toBe(sdkHeaders()["User-Agent"]);
});

test("test_sarvam_llm_build_params_excludes_pipecat_not_given_sentinel", () => {
  const service = make({ model: "sarvam-105b" });

  const builtParams = service.buildChatCompletionParams(invocation());

  // `undefined` values are dropped from the request body by JSON encoding;
  // the OpenAI-side sentinel is only checked here for Pipecat's NOT_GIVEN.
  expect(
    Object.values(builtParams).some((v) => v instanceof NotGiven) ||
      containsPipecatNotGiven(JSON.parse(JSON.stringify(builtParams))),
  ).toBe(false);
});

test("test_sarvam_llm_omits_optional_sarvam_fields_when_unset", () => {
  const service = make({ model: "sarvam-105b" });

  const builtParams = service.buildChatCompletionParams(invocation());

  expect("wiki_grounding" in builtParams).toBe(false);
  expect("reasoning_effort" in builtParams).toBe(false);
});

test("test_sarvam_llm_wiki_grounding_passed_via_extra_body", () => {
  const service = make({ model: "sarvam-105b", wikiGrounding: true });

  const builtParams = service.buildChatCompletionParams(invocation());

  expect("wiki_grounding" in builtParams).toBe(false);
  expect(builtParams.extra_body.wiki_grounding).toBe(true);
});

test("test_sarvam_llm_build_chat_completion_params_filters_unsupported_fields", () => {
  const service = make({
    model: "sarvam-105b",
    temperature: 0.7,
    maxTokens: 128,
    wikiGrounding: false,
    reasoningEffort: "medium",
  });

  const builtParams = service.buildChatCompletionParams(invocation());

  expect("stream_options" in builtParams).toBe(false);
  expect("max_completion_tokens" in builtParams).toBe(false);
  expect("service_tier" in builtParams).toBe(false);
  expect("wiki_grounding" in builtParams).toBe(false);
  expect(builtParams.extra_body.wiki_grounding).toBe(false);
  expect(builtParams.reasoning_effort).toBe("medium");
});

test("test_sarvam_llm_build_params_forward_core_and_extra_fields", () => {
  const service = make({
    model: "sarvam-105b",
    temperature: 0.9,
    topP: 0.8,
    frequencyPenalty: 0.1,
    presencePenalty: 0.2,
    seed: 11,
    maxTokens: 222,
    extra: { n: 2 },
  });

  const builtParams = service.buildChatCompletionParams(invocation());

  expect(builtParams.temperature).toBe(0.9);
  expect(builtParams.top_p).toBe(0.8);
  expect(builtParams.frequency_penalty).toBe(0.1);
  expect(builtParams.presence_penalty).toBe(0.2);
  expect(builtParams.seed).toBe(11);
  expect(builtParams.max_tokens).toBe(222);
  expect(builtParams.n).toBe(2);
});

test("test_sarvam_llm_extra_body_merges_with_user_extra", () => {
  const service = make({
    model: "sarvam-105b",
    wikiGrounding: true,
    extra: { extra_body: { user_field: 1 } },
  });

  const builtParams = service.buildChatCompletionParams(invocation());

  expect(builtParams.extra_body.user_field).toBe(1);
  expect(builtParams.extra_body.wiki_grounding).toBe(true);
});

test("test_sarvam_llm_tool_choice_requires_non_empty_tools", async () => {
  const service = make({ model: "sarvam-105b" });
  service._client = mockClient();
  const pushedErrors = withErrors(service);

  const context = new LLMContext({
    messages: [{ role: "user", content: "Hello" }],
    toolChoice: "required",
  });
  await service._processContext(context);

  expect(pushedErrors).toHaveLength(1);
  expect(service._client.chat.completions.create).not.toHaveBeenCalled();
  expect(pushedErrors[0]).toContain("requires non-empty `tools`");
});

test("test_sarvam_llm_tool_choice_with_tools_is_allowed", () => {
  const service = make({ model: "sarvam-105b" });

  const builtParams = service.buildChatCompletionParams(
    invocation({
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Lookup weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "required",
    }),
  );
  expect(builtParams.tool_choice).toBe("required");
  expect(builtParams.tools[0].function.name).toBe("lookup_weather");
});

test("test_sarvam_llm_rejects_image_input_on_non_vision_model", async () => {
  const service = make({ model: "sarvam-105b" });
  service._client = mockClient();
  const pushedErrors = withErrors(service);

  await service._processContext(new LLMContext({ messages: IMAGE_MESSAGES as Any }));

  expect(pushedErrors).toHaveLength(1);
  expect(service._client.chat.completions.create).not.toHaveBeenCalled();
  expect(pushedErrors[0]).toContain("does not support image input");
});

test("test_sarvam_llm_accepts_image_input_on_gemma4", () => {
  const service = make({ model: "gemma4" });

  const builtParams = service.buildChatCompletionParams(
    invocation({ messages: IMAGE_MESSAGES as Any }),
  );
  expect(builtParams.model).toBe("gemma4");
});

test("test_sarvam_llm_conversations_rejects_reasoning_effort", async () => {
  const service = make({ model: "sarvam-105b-conversations", reasoningEffort: "high" });
  service._client = mockClient();
  const pushedErrors = withErrors(service);

  await service._processContext(new LLMContext({ messages: [{ role: "user", content: "Hello" }] }));

  expect(pushedErrors).toHaveLength(1);
  expect(service._client.chat.completions.create).not.toHaveBeenCalled();
  expect(pushedErrors[0]).toContain("does not support reasoning_effort");
});

test("test_sarvam_llm_conversations_rejects_wiki_grounding", async () => {
  const service = make({ model: "sarvam-105b-conversations", wikiGrounding: true });
  service._client = mockClient();
  const pushedErrors = withErrors(service);

  await service._processContext(new LLMContext({ messages: [{ role: "user", content: "Hello" }] }));

  expect(pushedErrors).toHaveLength(1);
  expect(service._client.chat.completions.create).not.toHaveBeenCalled();
  expect(pushedErrors[0]).toContain("does not support wiki_grounding");
});

test("test_sarvam_llm_conversations_rejects_image_input", async () => {
  const service = make({ model: "sarvam-105b-conversations" });
  service._client = mockClient();
  const pushedErrors = withErrors(service);

  await service._processContext(new LLMContext({ messages: IMAGE_MESSAGES as Any }));

  expect(pushedErrors).toHaveLength(1);
  expect(service._client.chat.completions.create).not.toHaveBeenCalled();
  expect(pushedErrors[0]).toContain("does not support image input");
});

test("test_sarvam_llm_conversations_supports_tool_calling", () => {
  const service = make({ model: "sarvam-105b-conversations" });

  const builtParams = service.buildChatCompletionParams(
    invocation({
      messages: [{ role: "user", content: "Weather in Delhi?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "auto",
    }),
  );
  expect(builtParams.tool_choice).toBe("auto");
  expect(builtParams.tools[0].function.name).toBe("get_weather");
});

test("test_sarvam_llm_glm53_supports_reasoning_effort", () => {
  const service = make({ model: "glm5.3", reasoningEffort: "high" });

  const builtParams = service.buildChatCompletionParams(invocation());
  expect(builtParams.reasoning_effort).toBe("high");
});

test("test_sarvam_llm_glm53_rejects_wiki_grounding", async () => {
  const service = make({ model: "glm5.3", wikiGrounding: true });
  service._client = mockClient();
  const pushedErrors = withErrors(service);

  await service._processContext(new LLMContext({ messages: [{ role: "user", content: "Hello" }] }));

  expect(pushedErrors).toHaveLength(1);
  expect(service._client.chat.completions.create).not.toHaveBeenCalled();
  expect(pushedErrors[0]).toContain("does not support wiki_grounding");
});

test("test_sarvam_llm_glm53_rejects_image_input", async () => {
  const service = make({ model: "glm5.3" });
  service._client = mockClient();
  const pushedErrors = withErrors(service);

  await service._processContext(new LLMContext({ messages: IMAGE_MESSAGES as Any }));

  expect(pushedErrors).toHaveLength(1);
  expect(service._client.chat.completions.create).not.toHaveBeenCalled();
  expect(pushedErrors[0]).toContain("does not support image input");
});

test("test_sarvam_llm_update_settings_applies_runtime_sarvam_fields", async () => {
  const service = make({ model: "sarvam-105b" });

  const changed = await service._updateSettings(
    new SarvamLLMService.Settings({ wikiGrounding: true, reasoningEffort: "low" }),
  );

  const builtParams = service.buildChatCompletionParams(invocation());

  expect("wikiGrounding" in changed).toBe(true);
  expect("reasoningEffort" in changed).toBe(true);
  expect(builtParams.extra_body.wiki_grounding).toBe(true);
  expect(builtParams.reasoning_effort).toBe("low");
});

test("test_sarvam_llm_vision_validation_skips_non_dict_messages", async () => {
  const service = make({ model: "sarvam-105b" });
  service._client = mockClient();
  const pushedErrors = withErrors(service);

  // Non-dict entries should be skipped by vision validation, not cause an error
  const adapter = mockAdapter(
    invocation({
      messages: ["not a dict", null, { role: "user", content: "Hello" }] as Any,
    }),
  );
  service.getLlmAdapter = mock(() => adapter);

  const baseProcess = spyOn(
    OpenAILLMService.prototype as Any,
    "_processContext",
  ).mockImplementation(async () => {});
  let baseCalls = 0;
  try {
    await service._processContext(new LLMContext());
    baseCalls = baseProcess.mock.calls.length;
  } finally {
    baseProcess.mockRestore();
  }

  expect(pushedErrors).toHaveLength(0);
  expect(baseCalls).toBe(1);
});

test("test_sarvam_llm_run_inference_with_llm_context", async () => {
  const service = make({
    model: "sarvam-105b",
    temperature: 0.7,
    maxTokens: 100,
    frequencyPenalty: 0.5,
    seed: 42,
    wikiGrounding: true,
    reasoningEffort: "high",
  });
  service._client = mockClient(async () => completion("Hello! How can I help you today?"));

  const mockContext = {} as Any;
  const adapter = mockAdapter(
    invocation({
      messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello, world!" },
      ],
    }),
  );
  service.getLlmAdapter = mock(() => adapter);

  const result = await service.runInference(mockContext);

  expect(result).toBe("Hello! How can I help you today?");
  const callKwargs = service._client.chat.completions.create.mock.calls[0][0];
  expect(callKwargs.stream).toBe(false);
  expect("stream_options" in callKwargs).toBe(false);
  expect("max_completion_tokens" in callKwargs).toBe(false);
  expect("service_tier" in callKwargs).toBe(false);
  // The request body carries `extra_body` flattened (see the porting notes).
  expect("extra_body" in callKwargs).toBe(false);
  expect(callKwargs.wiki_grounding).toBe(true);
  expect(callKwargs.reasoning_effort).toBe("high");
});

test("test_sarvam_llm_run_inference_with_llm_context_object", async () => {
  const service = make({ model: "sarvam-105b", wikiGrounding: true });
  service._client = mockClient(async () => completion("Hello from LLM context"));

  const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

  const result = await service.runInference(context);

  expect(result).toBe("Hello from LLM context");
  const callKwargs = service._client.chat.completions.create.mock.calls[0][0];
  expect("extra_body" in callKwargs).toBe(false);
  expect(callKwargs.wiki_grounding).toBe(true);
});

test("test_sarvam_llm_run_inference_max_tokens_override", async () => {
  const service = make({ model: "sarvam-105b", maxTokens: 100 });
  service._client = mockClient(async () => completion("token override"));

  const adapter = mockAdapter(invocation());
  service.getLlmAdapter = mock(() => adapter);

  await service.runInference({} as Any, { maxTokens: 23 });

  const callKwargs = service._client.chat.completions.create.mock.calls[0][0];
  expect(callKwargs.max_tokens).toBe(23);
  expect("max_completion_tokens" in callKwargs).toBe(false);
});

test("test_sarvam_llm_run_inference_forwards_system_instruction", async () => {
  const service = make({ model: "sarvam-105b" });
  service._client = mockClient(async () => completion("instruction override"));

  const adapter = mockAdapter(invocation());
  service.getLlmAdapter = mock(() => adapter);

  await service.runInference({} as Any, { systemInstruction: "You are a concise assistant." });

  const adapterKwargs = adapter.getLlmInvocationParams.mock.calls[0][1];
  expect(adapterKwargs.systemInstruction).toBe("You are a concise assistant.");
});

test("test_sarvam_llm_timeout_errors_are_not_wrapped", async () => {
  const service = make({ model: "sarvam-105b" });
  service._client = mockClient(async () => {
    throw new TimeoutError();
  });

  const adapter = mockAdapter(invocation());
  service.getLlmAdapter = mock(() => adapter);

  await expect(service.runInference({} as Any)).rejects.toBeInstanceOf(TimeoutError);
});

test("test_sarvam_llm_run_inference_surfaces_raw_server_error", async () => {
  const service = make({ model: "sarvam-105b" });
  service._client = mockClient(async () => {
    throw new FakeSarvamError({ error: { message: "model is not available for this account" } });
  });

  const adapter = mockAdapter(invocation());
  service.getLlmAdapter = mock(() => adapter);

  let caught: unknown = null;
  try {
    await service.runInference({} as Any);
  } catch (e) {
    caught = e;
  }

  expect(caught).toBeInstanceOf(FakeSarvamError);
  expect((caught as FakeSarvamError).body).toEqual({
    error: { message: "model is not available for this account" },
  });
});

test("test_sarvam_llm_get_chat_completions_propagates_response_error", async () => {
  const service = make({ model: "sarvam-105b" });
  service._client = mockClient(async () => {
    throw new FakeSarvamResponseError("invalid request format");
  });

  const adapter = mockAdapter(invocation());
  service.getLlmAdapter = mock(() => adapter);

  await expect(service.getChatCompletions({} as Any)).rejects.toThrow("invalid request format");
});

test("test_sarvam_llm_process_frame_surfaces_raw_server_error", async () => {
  const service = make({ model: "sarvam-105b" });
  service._client = mockClient(async () => {
    throw new FakeSarvamError({ error: { message: "tool schema is invalid" } });
  });

  const pushedErrors: { errorMsg: string; exception: unknown }[] = [];
  service.pushError = async (errorMsg: string, options: { exception?: unknown } = {}) => {
    pushedErrors.push({ errorMsg, exception: options.exception ?? null });
  };
  service.pushFrame = mock(async () => {});
  service.startProcessingMetrics = mock(async () => {});
  service.stopProcessingMetrics = mock(async () => {});
  service.startTtfbMetrics = mock(async () => {});

  const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });
  await service.processFrame(new LLMContextFrame({ context }), FrameDirection.DOWNSTREAM);

  expect(pushedErrors).toHaveLength(1);
  expect(pushedErrors[0]!.errorMsg).toContain("Error during completion: Request failed");
  expect(pushedErrors[0]!.exception).toBeInstanceOf(FakeSarvamError);
  expect((pushedErrors[0]!.exception as FakeSarvamError).body).toEqual({
    error: { message: "tool schema is invalid" },
  });
});

test("test_sarvam_llm_stream_closed_on_cancellation", async () => {
  const service = make({ model: "sarvam-105b" });

  let streamClosed = false;

  class MockAsyncStream {
    iterationCount = 0;
    // The SDK's stream is closed through its controller.
    controller = {
      abort: () => {
        streamClosed = true;
      },
    };

    [Symbol.asyncIterator]() {
      return this;
    }

    async next(): Promise<IteratorResult<unknown>> {
      this.iterationCount += 1;
      if (this.iterationCount > 1) {
        throw new CancelledError();
      }
      return { done: false, value: { usage: null, model: null, choices: [] } };
    }
  }

  service._client = mockClient(async () => new MockAsyncStream());
  service.startTtfbMetrics = mock(async () => {});
  service.stopTtfbMetrics = mock(async () => {});
  service.startLlmUsageMetrics = mock(async () => {});

  const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });
  await expect(service._processContext(context)).rejects.toBeInstanceOf(CancelledError);

  expect(streamClosed).toBe(true);
});
