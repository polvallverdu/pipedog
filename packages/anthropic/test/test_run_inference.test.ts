// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_run_inference.py

/**
 * Tests for `runInference` across the LLM services.
 *
 * PORTING NOTES:
 * - The services of other providers are imported by relative path from their
 *   packages (`@pipedog/openai`, `@pipedog/google`, `@pipedog/aws`, ...), which
 *   this package does not depend on.
 * - `MagicMock(spec=LLMContext)` → a fresh `LLMContext`; the adapter is mocked,
 *   so the context is only passed through and compared by identity.
 * - `_mock_adapter()` → an object whose `getLlmInvocationParams` is a bun
 *   `mock`; `service.get_llm_adapter = MagicMock(...)` → assigning a `mock` to
 *   `service.getLlmAdapter`.
 * - Keyword arguments of `get_llm_invocation_params` become its options object
 *   (`system_instruction=None` → `systemInstruction: null`).
 * - `patch.object(Service, "create_client")` → `spyOn(Service.prototype,
 *   "createClient")` (or `_createClient`), restored after the test; the
 *   service's `_client` is then replaced by a fake with the SDK's method path
 *   (`chat.completions.create`, `beta.messages.create`, `models.generateContent`
 *   in the JS GenAI SDK, `responses.create`).
 * - SDK calls take a second `{ signal }` argument in JS; `call_args.kwargs` is
 *   the first argument (the request body).
 * - The OpenAI SDK's `NOT_GIVEN` is `undefined` (`OPENAI_NOT_GIVEN`); the Gemini
 *   invocation params' `tools=NotGiven()` is pipedog's `NOT_GIVEN`, which the
 *   Gemini adapter uses.
 * - The Anthropic JS SDK has no `extra_body` option, so the service merges
 *   `extra_body` into the request body itself. The upstream
 *   `extra_body={"temperature": ...}` kwarg is checked twice: as the merged
 *   request body the client receives, and as `extra_body` in the final
 *   params (captured from `_maybeApplyThinkingDefault`, the last step before
 *   the request, as in test_anthropic_sampling_settings).
 * - Bedrock: `patch.object(service._aws_session, "create_client", ...)` (an
 *   async context manager yielding the client) → spying on the service's
 *   `_createClient()`, which returns the client directly.
 * - Gemini's `GenerateContentConfig` uses the JS SDK's camelCase fields
 *   (`systemInstruction`, `responseMimeType`, `responseJsonSchema`); an unset
 *   field is absent (Python: `None`).
 * - loguru's `logger.add(sink, level="WARNING")` → `logger.addSink`, keeping
 *   WARNING-and-above records.
 */

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { OPENAI_NOT_GIVEN } from "@pipedog/core/adapters/llm/services/open_ai_adapter";
import { LLMContext, NOT_GIVEN } from "@pipedog/core/processors/aggregators/llm_context";
import { LOG_LEVELS, logger } from "@pipedog/core/utils/logger";
import { AWSBedrockLLMService } from "../../aws/src/llm.ts";
import { DeepSeekLLMService } from "../../deepseek/src/llm.ts";
import { GoogleLLMService } from "../../google/src/llm.ts";
import { OpenAILLMService } from "../../openai/src/llm.ts";
import {
  OpenAIResponsesHttpLLMService,
  OpenAIResponsesLLMService,
} from "../../openai/src/responses/llm.ts";
import { OpenRouterLLMService } from "../../openrouter/src/llm.ts";
import { AnthropicLLMService } from "../src/llm.ts";

type Internals = any;

/** Adapter mock with an async get_llm_invocation_params. */
function _mockAdapter(returnValue: unknown = undefined): Internals {
  return {
    getLlmInvocationParams: mock(async () => returnValue),
    getMessagesForLogging: mock(() => []),
  };
}

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

/** `patch.object(cls, name)`: stubs a prototype method until the test ends. */
function patchPrototype(cls: { prototype: unknown }, name: string): void {
  const spy = spyOn(cls.prototype as Internals, name).mockImplementation(() => ({}) as never);
  restores.push(() => spy.mockRestore());
}

function openaiService(
  options: Record<string, unknown> = {},
  cls: Internals = OpenAILLMService,
): Internals {
  patchPrototype(cls, "createClient");
  return new cls(options);
}

function responsesService(cls: Internals, options: Record<string, unknown> = {}): Internals {
  patchPrototype(cls, "_createClient");
  return new cls(options);
}

/** A chat completion mock whose first choice carries `content`. */
function chatCompletion(content: string): Internals {
  return { choices: [{ message: { content } }] };
}

function openaiClient(create: Internals): Internals {
  return { chat: { completions: { create } } };
}

function anthropicClient(create: Internals): Internals {
  return { beta: { messages: { create } } };
}

function googleClient(generateContent: Internals): Internals {
  return { models: { generateContent } };
}

function geminiResponse(text: string): Internals {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

/** `patch.object(service._aws_session, "create_client", ...)`. */
function patchBedrockClient(service: Internals, client: Internals): void {
  const spy = spyOn(service, "_createClient").mockReturnValue(client);
  restores.push(() => spy.mockRestore());
}

test("test_openai_run_inference_with_llm_context", async () => {
  // Create service with mocked client and specific parameters
  const service = openaiService({
    settings: new OpenAILLMService.Settings({
      model: "gpt-4",
      temperature: 0.7,
      maxTokens: 100,
      frequencyPenalty: 0.5,
      seed: 42,
    }),
  });

  // Setup mocks
  const mockContext = new LLMContext();
  const testMessages = [
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hello, world!" },
  ];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    tools: OPENAI_NOT_GIVEN,
    tool_choice: OPENAI_NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);

  // Mock response
  const create = mock(async () => chatCompletion("Hello! How can I help you today?"));
  service._client = openaiClient(create);

  // Execute
  const result = await service.runInference(mockContext);

  // Verify
  expect(result).toBe("Hello! How can I help you today?");
  expect(service.getLlmAdapter).toHaveBeenCalledTimes(1);
  // convertDeveloperToUser=false because OpenAILLMService.supportsDeveloperRole is true
  expect(mockAdapter.getLlmInvocationParams).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0]).toEqual([
    mockContext,
    { systemInstruction: null, convertDeveloperToUser: false },
  ]);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0][0]).toBe(mockContext);
  expect(create).toHaveBeenCalledTimes(1);
  expect((create.mock.calls[0] as Internals)[0]).toEqual({
    model: "gpt-4",
    stream: false,
    frequency_penalty: 0.5,
    presence_penalty: OPENAI_NOT_GIVEN,
    seed: 42,
    temperature: 0.7,
    top_p: OPENAI_NOT_GIVEN,
    max_tokens: 100,
    max_completion_tokens: OPENAI_NOT_GIVEN,
    service_tier: OPENAI_NOT_GIVEN,
    messages: testMessages,
    tools: OPENAI_NOT_GIVEN,
    tool_choice: OPENAI_NOT_GIVEN,
  });
});

test("test_openai_run_inference_client_exception", async () => {
  // Test that exceptions from the client are propagated.
  const service = openaiService({ settings: new OpenAILLMService.Settings({ model: "gpt-4" }) });

  const mockContext = new LLMContext();
  const mockAdapter = _mockAdapter({
    messages: [],
    tools: OPENAI_NOT_GIVEN,
    tool_choice: OPENAI_NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  service._client = openaiClient(
    mock(async () => {
      throw new Error("API Error");
    }),
  );

  await expect(service.runInference(mockContext)).rejects.toThrow("API Error");
});

test("test_openrouter_run_inference_converts_developer_messages_to_user", async () => {
  // OpenRouter requests convert developer messages for broad model compatibility.
  const service = openaiService(
    { apiKey: "test-key", settings: new OpenRouterLLMService.Settings({ model: "gpt-4" }) },
    OpenRouterLLMService,
  );

  const mockContext = new LLMContext();
  const mockAdapter = _mockAdapter({
    messages: [{ role: "user", content: "Tool result" }],
    tools: OPENAI_NOT_GIVEN,
    tool_choice: OPENAI_NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  service._client = openaiClient(mock(async () => chatCompletion("Done")));

  const result = await service.runInference(mockContext);

  expect(result).toBe("Done");
  expect(mockAdapter.getLlmInvocationParams).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0]).toEqual([
    mockContext,
    { systemInstruction: null, convertDeveloperToUser: true },
  ]);
});

test("test_anthropic_run_inference_with_llm_context", async () => {
  // Create service with mocked client and specific parameters
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({
      model: "claude-3-sonnet-20240229",
      maxTokens: 2048,
      temperature: 0.6,
      topK: 50,
      topP: 0.95,
    }),
  }) as Internals;

  // Setup mocks
  const mockContext = new LLMContext();
  const testMessages = [{ role: "user", content: "Hello, world!" }];
  const testSystem = "You are a helpful assistant";
  const mockAdapter = _mockAdapter({ messages: testMessages, system: testSystem, tools: [] });
  service.getLlmAdapter = mock(() => mockAdapter);

  // Mock response
  const create = mock(async () => ({
    content: [{ type: "text", text: "Hello! How can I help you today?" }],
  }));
  service._client = anthropicClient(create);
  const finalParams = spyOn(service, "_maybeApplyThinkingDefault");

  // Execute
  const result = await service.runInference(mockContext);

  // Verify
  expect(result).toBe("Hello! How can I help you today?");
  expect(service.getLlmAdapter).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0]).toEqual([
    mockContext,
    {
      enablePromptCaching: false,
      systemInstruction: null,
      ensureLastMessageIsUser: false,
      systemPromptCacheTtl: null,
    },
  ]);
  expect(finalParams.mock.calls[0]![0]).toEqual({
    model: "claude-3-sonnet-20240229",
    max_tokens: 2048,
    stream: false,
    messages: testMessages,
    system: testSystem,
    tools: [],
    betas: ["interleaved-thinking-2025-05-14"],
    extra_body: { temperature: 0.6, top_k: 50, top_p: 0.95 },
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect((create.mock.calls[0] as Internals)[0]).toEqual({
    model: "claude-3-sonnet-20240229",
    max_tokens: 2048,
    stream: false,
    messages: testMessages,
    system: testSystem,
    tools: [],
    betas: ["interleaved-thinking-2025-05-14"],
    temperature: 0.6,
    top_k: 50,
    top_p: 0.95,
  });
});

test("test_anthropic_run_inference_client_exception", async () => {
  // Test that exceptions from the Anthropic client are propagated.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-3-sonnet-20240229" }),
  }) as Internals;

  const mockContext = new LLMContext();
  const mockAdapter = _mockAdapter({ messages: [], system: "Test system", tools: [] });
  service.getLlmAdapter = mock(() => mockAdapter);
  service._client = anthropicClient(
    mock(async () => {
      throw new Error("Anthropic API Error");
    }),
  );

  await expect(service.runInference(mockContext)).rejects.toThrow("Anthropic API Error");
});

test("test_google_run_inference_with_llm_context", async () => {
  // Create service with mocked client
  const service = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ model: "gemini-2.0-flash" }),
  }) as Internals;

  // Setup mocks
  const mockContext = new LLMContext();
  const testMessages = [{ role: "user", content: "Hello, world!" }];
  const testSystem = "You are a helpful assistant";
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    system_instruction: testSystem,
    tools: NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);

  // Mock response
  const generateContent = mock(async () => geminiResponse("Hello! How can I help you today?"));
  service._client = googleClient(generateContent);

  // Execute
  const result = await service.runInference(mockContext);

  // Verify
  expect(result).toBe("Hello! How can I help you today?");
  expect(service.getLlmAdapter).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0]).toEqual([
    mockContext,
    { systemInstruction: null, ensureLastMessageIsUser: false },
  ]);
  expect(generateContent).toHaveBeenCalledTimes(1);
});

test("test_google_run_inference_client_exception", async () => {
  // Test that exceptions from the Google client are propagated.
  const service = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ model: "gemini-2.0-flash" }),
  }) as Internals;

  const mockContext = new LLMContext();
  const mockAdapter = _mockAdapter({
    messages: [],
    system_instruction: "Test system",
    tools: NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  service._client = googleClient(
    mock(async () => {
      throw new Error("Google API Error");
    }),
  );

  await expect(service.runInference(mockContext)).rejects.toThrow("Google API Error");
});

test("test_aws_bedrock_run_inference_with_llm_context", async () => {
  // Create service with specific parameters
  const service = new AWSBedrockLLMService({
    settings: new AWSBedrockLLMService.Settings({
      model: "anthropic.claude-3-sonnet-20240229-v1:0",
      maxTokens: 1024,
      temperature: 0.5,
      topP: 0.85,
    }),
  }) as Internals;

  // Setup mocks
  const mockContext = new LLMContext();
  const testMessages = [{ role: "user", content: [{ text: "Hello, world!" }] }];
  const testSystem = [{ text: "You are a helpful assistant" }];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    system: testSystem,
    tools: [],
    tool_choice: null,
  });
  service.getLlmAdapter = mock(() => mockAdapter);

  // Mock the client and response
  const converse = mock(async () => ({
    output: { message: { content: [{ text: "Hello! How can I help you today?" }] } },
  }));
  patchBedrockClient(service, { converse });

  // Execute
  const result = await service.runInference(mockContext);

  // Verify
  expect(result).toBe("Hello! How can I help you today?");
  expect(service.getLlmAdapter).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0]).toEqual([
    mockContext,
    { systemInstruction: null, ensureLastMessageIsUser: false },
  ]);

  // Verify the call includes configured parameters
  const callKwargs = (converse.mock.calls.at(-1) as Internals)[0];
  expect(callKwargs.modelId).toBe("anthropic.claude-3-sonnet-20240229-v1:0");
  expect(callKwargs.messages).toEqual(testMessages);
  expect(callKwargs.system).toEqual(testSystem);
  expect(callKwargs.additionalModelRequestFields).toEqual({});
  expect("inferenceConfig" in callKwargs).toBe(true);
  expect(callKwargs.inferenceConfig.maxTokens).toBe(1024);
  expect(callKwargs.inferenceConfig.temperature).toBe(0.5);
  expect(callKwargs.inferenceConfig.topP).toBe(0.85);
});

test("test_aws_bedrock_run_inference_client_exception", async () => {
  // Test that exceptions from the AWS Bedrock client are propagated.
  const service = new AWSBedrockLLMService({
    settings: new AWSBedrockLLMService.Settings({
      model: "anthropic.claude-3-sonnet-20240229-v1:0",
    }),
  }) as Internals;

  const mockContext = new LLMContext();
  const mockAdapter = _mockAdapter({
    messages: [],
    system: [{ text: "Test system" }],
    tools: [],
    tool_choice: null,
  });
  service.getLlmAdapter = mock(() => mockAdapter);

  // Mock AWS client to raise exception
  patchBedrockClient(service, {
    converse: mock(async () => {
      throw new Error("Bedrock API Error");
    }),
  });

  await expect(service.runInference(mockContext)).rejects.toThrow("Bedrock API Error");
});

test("test_aws_bedrock_streaming_captures_all_tool_calls", async () => {
  // AWS Bedrock streaming captures every parallel tool call, not just the last.
  const service = new AWSBedrockLLMService({
    settings: new AWSBedrockLLMService.Settings({
      model: "anthropic.claude-3-sonnet-20240229-v1:0",
    }),
  }) as Internals;

  const mockContext = new LLMContext();
  const mockAdapter = _mockAdapter({
    messages: [{ role: "user", content: [{ text: "What's the weather?" }] }],
    system: [],
    tools: [{ toolSpec: { name: "get_weather" } }],
    tool_choice: null,
  });
  service.getLlmAdapter = mock(() => mockAdapter);

  // Two tool calls in one streamed response, each its own content block keyed
  // by contentBlockIndex, finalized with contentBlockStop before messageStop.
  const streamEvents = [
    {
      contentBlockStart: {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: "id-0", name: "get_weather" } },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { toolUse: { input: '{"city": "SF"}' } },
      },
    },
    { contentBlockStop: { contentBlockIndex: 0 } },
    {
      contentBlockStart: {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: "id-1", name: "get_weather" } },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 1,
        delta: { toolUse: { input: '{"city": "NY"}' } },
      },
    },
    { contentBlockStop: { contentBlockIndex: 1 } },
    { messageStop: { stopReason: "tool_use" } },
  ];

  async function* fakeStream() {
    for (const event of streamEvents) {
      yield event;
    }
  }

  const captured: Internals[] = [];
  service.runFunctionCalls = mock(async (calls: Internals[]) => {
    captured.push(...calls);
  });

  patchBedrockClient(service, {});
  const streamSpy = spyOn(service, "_createConverseStream").mockResolvedValue({
    stream: fakeStream(),
  });
  restores.push(() => streamSpy.mockRestore());

  await service._processContext(mockContext);

  expect(captured.length).toBe(2);
  expect(captured.map((c) => c.arguments.city).sort()).toEqual(["NY", "SF"]);
  expect(captured.map((c) => c.toolCallId).sort()).toEqual(["id-0", "id-1"]);
});

// --- system_instruction parameter tests ---

test("test_openai_run_inference_system_instruction_overrides_context", async () => {
  // system_instruction overrides the system message from context.
  const service = openaiService({ settings: new OpenAILLMService.Settings({ model: "gpt-4" }) });

  const mockContext = new LLMContext();
  const testMessages = [
    { role: "system", content: "Original system message" },
    { role: "user", content: "Hello" },
  ];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    tools: OPENAI_NOT_GIVEN,
    tool_choice: OPENAI_NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  service._client = openaiClient(mock(async () => chatCompletion("Response")));

  const result = await service.runInference(mockContext, {
    systemInstruction: "New system instruction",
  });

  expect(result).toBe("Response");
  // Verify the adapter was called with the correct system_instruction.
  // convertDeveloperToUser=false because OpenAILLMService.supportsDeveloperRole is true.
  expect(mockAdapter.getLlmInvocationParams).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0]).toEqual([
    mockContext,
    { systemInstruction: "New system instruction", convertDeveloperToUser: false },
  ]);
});

test("test_openai_run_inference_system_instruction_none_unchanged", async () => {
  // When system_instruction is None, behavior is unchanged.
  const service = openaiService({ settings: new OpenAILLMService.Settings({ model: "gpt-4" }) });

  const mockContext = new LLMContext();
  const testMessages = [
    { role: "system", content: "Original system message" },
    { role: "user", content: "Hello" },
  ];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    tools: OPENAI_NOT_GIVEN,
    tool_choice: OPENAI_NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  const create = mock(async () => chatCompletion("Response"));
  service._client = openaiClient(create);

  const result = await service.runInference(mockContext);

  expect(result).toBe("Response");
  const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
  const messages = callKwargs.messages;
  expect(messages[0]).toEqual({ role: "system", content: "Original system message" });
  expect(messages[1]).toEqual({ role: "user", content: "Hello" });
});

test("test_anthropic_run_inference_system_instruction_overrides_context", async () => {
  // system_instruction overrides the system message for Anthropic.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-3-sonnet-20240229" }),
  }) as Internals;

  const mockContext = new LLMContext();
  const testMessages = [{ role: "user", content: "Hello" }];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    system: "Original system",
    tools: [],
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  service._client = anthropicClient(
    mock(async () => ({ content: [{ type: "text", text: "Response" }] })),
  );

  const result = await service.runInference(mockContext, {
    systemInstruction: "New system instruction",
  });

  expect(result).toBe("Response");
  // Verify the adapter was called with the correct system_instruction
  expect(mockAdapter.getLlmInvocationParams).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0]).toEqual([
    mockContext,
    {
      enablePromptCaching: false,
      systemInstruction: "New system instruction",
      ensureLastMessageIsUser: false,
      systemPromptCacheTtl: null,
    },
  ]);
});

test.each([[null], ["1h"]] as const)(
  "test_anthropic_run_inference_system_prompt_cache_ttl[%p]",
  async (ttl) => {
    // The system_prompt_cache_ttl setting reaches the system prompt sent to Anthropic.
    const service = new AnthropicLLMService({
      apiKey: "test-key",
      settings: new AnthropicLLMService.Settings({
        model: "claude-3-sonnet-20240229",
        enablePromptCaching: true,
        systemPromptCacheTtl: ttl,
      }),
    }) as Internals;
    const create = mock(async () => ({ content: [] }));
    service._client = anthropicClient(create);

    await service.runInference(new LLMContext({ messages: [{ role: "user", content: "Hello" }] }), {
      systemInstruction: "Be helpful.",
    });

    const system = (create.mock.calls.at(-1) as Internals)[0].system;
    expect(system.length).toBe(1);
    const [systemBlock] = system;
    // `dict.get("ttl")`: an absent key reads as None.
    expect(systemBlock.cache_control.ttl ?? null).toBe(ttl);
  },
);

test("test_anthropic_run_inference_system_instruction_none_unchanged", async () => {
  // When system_instruction is None, Anthropic behavior is unchanged.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-3-sonnet-20240229" }),
  }) as Internals;

  const mockContext = new LLMContext();
  const testMessages = [{ role: "user", content: "Hello" }];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    system: "Original system",
    tools: [],
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  const create = mock(async () => ({ content: [{ type: "text", text: "Response" }] }));
  service._client = anthropicClient(create);

  const result = await service.runInference(mockContext);

  expect(result).toBe("Response");
  const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
  expect(callKwargs.system).toBe("Original system");
});

test("test_google_run_inference_system_instruction_overrides_context", async () => {
  // system_instruction overrides the system message for Google.
  const service = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ model: "gemini-2.0-flash" }),
  }) as Internals;

  const mockContext = new LLMContext();
  const testMessages = [{ role: "user", content: "Hello" }];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    system_instruction: "Original system",
    tools: NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  service._client = googleClient(mock(async () => geminiResponse("Response")));

  const result = await service.runInference(mockContext, {
    systemInstruction: "New system instruction",
  });

  expect(result).toBe("Response");
  // Verify the adapter was called with the correct system_instruction
  expect(mockAdapter.getLlmInvocationParams).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0]).toEqual([
    mockContext,
    { systemInstruction: "New system instruction", ensureLastMessageIsUser: false },
  ]);
});

test("test_google_run_inference_system_instruction_none_unchanged", async () => {
  // When system_instruction is None, Google behavior is unchanged.
  const service = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ model: "gemini-2.0-flash" }),
  }) as Internals;

  const mockContext = new LLMContext();
  const testMessages = [{ role: "user", content: "Hello" }];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    system_instruction: "Original system",
    tools: NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  const generateContent = mock(async () => geminiResponse("Response"));
  service._client = googleClient(generateContent);

  const result = await service.runInference(mockContext);

  expect(result).toBe("Response");
  const callKwargs = (generateContent.mock.calls.at(-1) as Internals)[0];
  const config = callKwargs.config;
  expect(config.systemInstruction).toBe("Original system");
});

test("test_aws_bedrock_run_inference_system_instruction_overrides_context", async () => {
  // system_instruction overrides the system message for AWS Bedrock.
  const service = new AWSBedrockLLMService({
    settings: new AWSBedrockLLMService.Settings({
      model: "anthropic.claude-3-sonnet-20240229-v1:0",
    }),
  }) as Internals;

  const mockContext = new LLMContext();
  const testMessages = [{ role: "user", content: [{ text: "Hello" }] }];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    system: [{ text: "Original system" }],
    tools: [],
    tool_choice: null,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  patchBedrockClient(service, {
    converse: mock(async () => ({ output: { message: { content: [{ text: "Response" }] } } })),
  });

  const result = await service.runInference(mockContext, {
    systemInstruction: "New system instruction",
  });

  expect(result).toBe("Response");
  // Verify the adapter was called with the correct system_instruction
  expect(mockAdapter.getLlmInvocationParams).toHaveBeenCalledTimes(1);
  expect(mockAdapter.getLlmInvocationParams.mock.calls[0]).toEqual([
    mockContext,
    { systemInstruction: "New system instruction", ensureLastMessageIsUser: false },
  ]);
});

test("test_aws_bedrock_run_inference_system_instruction_none_unchanged", async () => {
  // When system_instruction is None, AWS Bedrock behavior is unchanged.
  const service = new AWSBedrockLLMService({
    settings: new AWSBedrockLLMService.Settings({
      model: "anthropic.claude-3-sonnet-20240229-v1:0",
    }),
  }) as Internals;

  const mockContext = new LLMContext();
  const testMessages = [{ role: "user", content: [{ text: "Hello" }] }];
  const mockAdapter = _mockAdapter({
    messages: testMessages,
    system: [{ text: "Original system" }],
    tools: [],
    tool_choice: null,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  const converse = mock(async () => ({
    output: { message: { content: [{ text: "Response" }] } },
  }));
  patchBedrockClient(service, { converse });

  const result = await service.runInference(mockContext);

  expect(result).toBe("Response");
  const callKwargs = (converse.mock.calls.at(-1) as Internals)[0];
  expect(callKwargs.system).toEqual([{ text: "Original system" }]);
});

// --- OpenAI Responses API tests ---
// The HTTP variant's tests mirror the WebSocket variant's, verifying that the
// HTTP variant's runInference (inherited from the shared base class) works
// identically.

for (const [prefix, cls] of [
  ["test_openai_responses", OpenAIResponsesLLMService],
  ["test_openai_responses_http", OpenAIResponsesHttpLLMService],
] as const) {
  test(`${prefix}_run_inference_with_llm_context`, async () => {
    // runInference with LLMContext returns expected response.
    const service = responsesService(cls, {
      settings: new cls.Settings({
        model: "gpt-4.1",
        systemInstruction: "You are a helpful assistant",
        temperature: 0.7,
        maxCompletionTokens: 100,
      }),
    });

    const context = new LLMContext({ messages: [{ role: "user", content: "Hello, world!" }] });

    const create = mock(async () => ({ output_text: "Hello! How can I help you today?" }));
    service._client = { responses: { create } };

    const result = await service.runInference(context);

    expect(result).toBe("Hello! How can I help you today?");
    const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
    expect(callKwargs.model).toBe("gpt-4.1");
    expect(callKwargs.stream).toBe(false);
    expect(callKwargs.store).toBe(false);
    expect(callKwargs.input).toEqual([{ role: "user", content: "Hello, world!" }]);
    expect(callKwargs.instructions).toBe("You are a helpful assistant");
    expect(callKwargs.temperature).toBe(0.7);
    expect(callKwargs.max_output_tokens).toBe(100);
  });

  test(`${prefix}_run_inference_client_exception`, async () => {
    // Exceptions from the client are propagated.
    const service = responsesService(cls);

    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });
    service._client = {
      responses: {
        create: mock(async () => {
          throw new Error("API Error");
        }),
      },
    };

    await expect(service.runInference(context)).rejects.toThrow("API Error");
  });

  test(`${prefix}_run_inference_system_instruction_overrides`, async () => {
    // The systemInstruction parameter overrides the settings instruction.
    const service = responsesService(cls, {
      settings: new cls.Settings({ model: "gpt-4.1", systemInstruction: "Original instruction" }),
    });

    const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

    const create = mock(async () => ({ output_text: "Response" }));
    service._client = { responses: { create } };

    const result = await service.runInference(context, {
      systemInstruction: "New system instruction",
    });

    expect(result).toBe("Response");
    const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
    expect(callKwargs.instructions).toBe("New system instruction");
    expect(callKwargs.input).toEqual([{ role: "user", content: "Hello" }]);
  });

  test(`${prefix}_run_inference_empty_context_with_instruction`, async () => {
    // The system instruction becomes a developer message when context is empty.
    const service = responsesService(cls, {
      settings: new cls.Settings({ model: "gpt-4.1", systemInstruction: "You are helpful" }),
    });

    const context = new LLMContext({ messages: [] });

    const create = mock(async () => ({ output_text: "Response" }));
    service._client = { responses: { create } };

    const result = await service.runInference(context);

    expect(result).toBe("Response");
    const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
    // With empty context, instruction should become a developer message
    expect(callKwargs.input).toEqual([{ role: "developer", content: "You are helpful" }]);
    expect("instructions" in callKwargs).toBe(false);
  });

  test(`${prefix}_run_inference_max_tokens_override`, async () => {
    // The maxTokens parameter overrides max_output_tokens.
    const service = responsesService(cls, {
      settings: new cls.Settings({ model: "gpt-4.1", maxCompletionTokens: 500 }),
    });

    const context = new LLMContext({ messages: [{ role: "user", content: "Summarize this" }] });

    const create = mock(async () => ({ output_text: "Summary" }));
    service._client = { responses: { create } };

    const result = await service.runInference(context, { maxTokens: 200 });

    expect(result).toBe("Summary");
    const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
    expect(callKwargs.max_output_tokens).toBe(200);
  });

  test(`${prefix}_run_inference_system_instruction_param_with_empty_context`, async () => {
    // The systemInstruction param becomes a developer message when context is empty.
    //
    // The Responses API rejects requests with instructions but no input items.
    // When runInference is called with an explicit systemInstruction and an
    // empty context, the instruction must become a developer message — not be
    // sent as the instructions parameter.
    const service = responsesService(cls, {
      settings: new cls.Settings({ model: "gpt-4.1" }),
    });

    const context = new LLMContext({ messages: [] });

    const create = mock(async () => ({ output_text: "Response" }));
    service._client = { responses: { create } };

    const result = await service.runInference(context, {
      systemInstruction: "Summarize the conversation",
    });

    expect(result).toBe("Response");
    const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
    expect(callKwargs.input).toEqual([
      { role: "developer", content: "Summarize the conversation" },
    ]);
    expect("instructions" in callKwargs).toBe(false);
  });
}

// A reply schema for the response_schema tests.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string", enum: ["yes", "no"] } },
  required: ["answer"],
  additionalProperties: false,
};

test("test_openai_run_inference_response_schema", async () => {
  // A response schema goes to chat completions as a strict json_schema response format.
  const service = openaiService({
    settings: new OpenAILLMService.Settings({ model: "gpt-4o-mini" }),
  });
  const create = mock(async () => chatCompletion('{"answer": "yes"}'));
  service._client = openaiClient(create);

  const result = await service.runInference(
    new LLMContext({ messages: [{ role: "user", content: "Is water wet?" }] }),
    { responseSchema: RESPONSE_SCHEMA },
  );

  expect(result).toBe('{"answer": "yes"}');
  const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
  expect(callKwargs.response_format).toEqual({
    type: "json_schema",
    json_schema: { name: "response", schema: RESPONSE_SCHEMA, strict: true },
  });
});

test("test_openai_run_inference_without_response_schema_sends_no_format", async () => {
  const service = openaiService({
    settings: new OpenAILLMService.Settings({ model: "gpt-4o-mini" }),
  });
  const create = mock(async () => chatCompletion("yes"));
  service._client = openaiClient(create);

  await service.runInference(new LLMContext({ messages: [{ role: "user", content: "?" }] }));

  expect("response_format" in (create.mock.calls.at(-1) as Internals)[0]).toBe(false);
});

test("test_openai_responses_run_inference_response_schema", async () => {
  // A response schema goes to the Responses API as a strict json_schema text format.
  const service = responsesService(OpenAIResponsesLLMService, {
    settings: new OpenAIResponsesLLMService.Settings({ model: "gpt-4.1" }),
  });
  const create = mock(async () => ({ output_text: '{"answer": "no"}' }));
  service._client = { responses: { create } };

  const result = await service.runInference(
    new LLMContext({ messages: [{ role: "user", content: "Is fire cold?" }] }),
    { responseSchema: RESPONSE_SCHEMA },
  );

  expect(result).toBe('{"answer": "no"}');
  const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
  expect(callKwargs.text).toEqual({
    format: {
      type: "json_schema",
      name: "response",
      schema: RESPONSE_SCHEMA,
      strict: true,
    },
  });
});

test("test_anthropic_run_inference_response_schema", async () => {
  // A response schema goes to Anthropic as a json_schema output format.
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-haiku-4-5" }),
  }) as Internals;
  const mockAdapter = _mockAdapter({
    messages: [{ role: "user", content: "Is water wet?" }],
    system: "Answer.",
    tools: [],
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  const create = mock(async () => ({ content: [{ type: "text", text: '{"answer": "yes"}' }] }));
  service._client = anthropicClient(create);

  const result = await service.runInference(new LLMContext(), {
    responseSchema: RESPONSE_SCHEMA,
  });

  expect(result).toBe('{"answer": "yes"}');
  const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
  expect(callKwargs.output_config).toEqual({
    format: { type: "json_schema", schema: RESPONSE_SCHEMA },
  });
});

test("test_google_run_inference_response_schema", async () => {
  // A response schema goes to Gemini as a JSON mime type and a response JSON schema.
  const service = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ model: "gemini-2.5-flash" }),
  }) as Internals;
  const mockAdapter = _mockAdapter({
    messages: [{ role: "user", content: "Is water wet?" }],
    system_instruction: "Answer.",
    tools: NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  const generateContent = mock(async () => geminiResponse('{"answer": "yes"}'));
  service._client = googleClient(generateContent);

  const result = await service.runInference(new LLMContext(), {
    responseSchema: RESPONSE_SCHEMA,
  });

  expect(result).toBe('{"answer": "yes"}');
  const config = (generateContent.mock.calls.at(-1) as Internals)[0].config;
  expect(config.responseMimeType).toBe("application/json");
  expect(config.responseJsonSchema).toEqual(RESPONSE_SCHEMA);
});

test("test_aws_bedrock_run_inference_ignores_response_schema", async () => {
  // Bedrock has no reply schema, so the request goes out without one.
  const service = new AWSBedrockLLMService({
    settings: new AWSBedrockLLMService.Settings({
      model: "anthropic.claude-3-sonnet-20240229-v1:0",
    }),
  }) as Internals;
  const mockAdapter = _mockAdapter({
    messages: [{ role: "user", content: [{ text: "Is water wet?" }] }],
    system: [{ text: "Answer." }],
    tools: [],
    tool_choice: null,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  const converse = mock(async () => ({ output: { message: { content: [{ text: "yes" }] } } }));
  patchBedrockClient(service, { converse });

  const result = await service.runInference(new LLMContext(), {
    responseSchema: RESPONSE_SCHEMA,
  });

  expect(result).toBe("yes");
  expect("toolConfig" in (converse.mock.calls.at(-1) as Internals)[0]).toBe(false);
});

test.each([
  ["gpt-4o-mini", true],
  ["gpt-4o-2024-08-06", true],
  ["gpt-4.1", true],
  ["gpt-5-mini", true],
  ["o3", true],
  ["gpt-4o-2024-05-13", false],
  ["gpt-4-turbo", false],
  ["gpt-4", false],
  ["gpt-3.5-turbo", false],
  ["o1-mini", false],
] as const)("test_openai_supports_response_schema[%s-%p]", (model, supported) => {
  expect(OpenAILLMService.supportsResponseSchema).toBe(true);
  expect(OpenAILLMService.modelSupportsResponseSchema(model)).toBe(supported);
  expect(OpenAIResponsesLLMService.supportsResponseSchema).toBe(true);
  expect(OpenAIResponsesLLMService.modelSupportsResponseSchema(model)).toBe(supported);
});

test.each([
  ["claude-haiku-4-5", true],
  ["claude-sonnet-4-5-20250929", true],
  ["claude-opus-4-6", true],
  ["claude-fable-5-1", true],
  ["claude-mythos-preview", true],
  ["claude-opus-4-1-20250805", false],
  ["claude-sonnet-4-20250514", false],
  ["claude-3-7-sonnet-20250219", false],
  ["claude-3-5-haiku-20241022", false],
] as const)("test_anthropic_supports_response_schema[%s-%p]", (model, supported) => {
  expect(AnthropicLLMService.supportsResponseSchema).toBe(true);
  expect(AnthropicLLMService.modelSupportsResponseSchema(model)).toBe(supported);
});

test.each([
  ["gemini-2.5-flash", true],
  ["gemini-3.6-flash", true],
  ["gemini-3.1-pro-preview", true],
  ["gemini-flash-latest", true],
  ["gemini-2.0-flash-001", false],
  ["gemini-1.5-pro", false],
] as const)("test_google_supports_response_schema[%s-%p]", (model, supported) => {
  expect(GoogleLLMService.supportsResponseSchema).toBe(true);
  expect(GoogleLLMService.modelSupportsResponseSchema(model)).toBe(supported);
});

test("test_services_without_response_schema", () => {
  // Bedrock's Converse API and DeepSeek's chat API have no reply schema.
  expect(AWSBedrockLLMService.supportsResponseSchema).toBe(false);
  expect(DeepSeekLLMService.supportsResponseSchema).toBe(false);
});

test("test_openai_run_inference_response_schema_ignored_on_legacy_model", async () => {
  // A model without schema support gets no response format, and a warning says so.
  const warningsSeen: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) warningsSeen.push(record.message);
  });
  let service: Internals;
  let create: Internals;
  let result: string | null;
  try {
    service = openaiService({ settings: new OpenAILLMService.Settings({ model: "gpt-4-turbo" }) });
    create = mock(async () => chatCompletion("yes"));
    service._client = openaiClient(create);

    result = await service.runInference(
      new LLMContext({ messages: [{ role: "user", content: "?" }] }),
      { responseSchema: RESPONSE_SCHEMA },
    );
  } finally {
    remove();
  }

  expect(result).toBe("yes");
  expect("response_format" in create.mock.calls.at(-1)[0]).toBe(false);
  expect(
    warningsSeen.some((m) => m.includes("response_schema is not supported by model gpt-4-turbo")),
  ).toBe(true);
});

test("test_anthropic_run_inference_response_schema_ignored_on_legacy_model", async () => {
  const service = new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-3-5-haiku-20241022" }),
  }) as Internals;
  const mockAdapter = _mockAdapter({
    messages: [{ role: "user", content: "Is water wet?" }],
    system: "Answer.",
    tools: [],
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  const create = mock(async () => ({ content: [{ type: "text", text: "yes" }] }));
  service._client = anthropicClient(create);

  const result = await service.runInference(new LLMContext(), {
    responseSchema: RESPONSE_SCHEMA,
  });

  expect(result).toBe("yes");
  const callKwargs = (create.mock.calls.at(-1) as Internals)[0];
  expect("output_config" in callKwargs).toBe(false);
});

test("test_google_run_inference_response_schema_ignored_on_legacy_model", async () => {
  const service = new GoogleLLMService({
    apiKey: "test-key",
    settings: new GoogleLLMService.Settings({ model: "gemini-2.0-flash" }),
  }) as Internals;
  const mockAdapter = _mockAdapter({
    messages: [{ role: "user", content: "Is water wet?" }],
    system_instruction: "Answer.",
    tools: NOT_GIVEN,
  });
  service.getLlmAdapter = mock(() => mockAdapter);
  const generateContent = mock(async () => geminiResponse("yes"));
  service._client = googleClient(generateContent);

  const result = await service.runInference(new LLMContext(), {
    responseSchema: RESPONSE_SCHEMA,
  });

  expect(result).toBe("yes");
  const config = (generateContent.mock.calls.at(-1) as Internals)[0].config;
  // An unset GenerateContentConfig field is absent (Python: None).
  expect(config.responseMimeType ?? null).toBeNull();
  expect(config.responseJsonSchema ?? null).toBeNull();
});
