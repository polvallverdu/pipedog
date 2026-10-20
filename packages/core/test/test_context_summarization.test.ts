// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_context_summarization.py

/** Tests for context summarization feature. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { sleep } from "@pipedog/asyncio";

import { SystemClock } from "../src/clocks/system_clock.ts";
import { LLMContextSummaryRequestFrame, LLMFullResponseStartFrame } from "../src/frames/frames.ts";
import {
  LLMContext,
  type LLMContextMessage,
  LLMSpecificMessage,
} from "../src/processors/aggregators/llm_context.ts";
import { LLMContextSummarizer } from "../src/processors/aggregators/llm_context_summarizer.ts";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import { LLMService } from "../src/services/llm_service.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";
import {
  LLMAutoContextSummarizationConfig,
  LLMContextSummarizationUtil,
  LLMContextSummaryConfig,
} from "../src/utils/context/llm_context_summarization.ts";

/**
 * Build a setup configuration for a processor used outside a pipeline.
 *
 * Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`.
 */
function frameProcessorSetup(
  taskManager: BaseTaskManager | null = null,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager: taskManager as BaseTaskManager,
  });
}

// Protected members the upstream tests reach into directly.
const Util = LLMContextSummarizationUtil as any;
const svc = (llm: LLMService): any => llm;
const summ = (s: LLMContextSummarizer): any => s;

describe("TestContextSummarizationMixin", () => {
  test("test_estimate_tokens_simple_text", () => {
    // Simple sentence: "Hello world" = 11 chars / 4 = 2.75 -> 2 tokens
    let tokens = LLMContextSummarizationUtil.estimateTokens("Hello world");
    expect(tokens).toEqual(2);

    // More words: "This is a test message" = 22 chars / 4 = 5.5 -> 5 tokens
    tokens = LLMContextSummarizationUtil.estimateTokens("This is a test message");
    expect(tokens).toEqual(5);
  });

  test("test_estimate_tokens_empty", () => {
    const tokens = LLMContextSummarizationUtil.estimateTokens("");
    expect(tokens).toEqual(0);
  });

  test("test_estimate_context_tokens", () => {
    const context = new LLMContext();

    // Empty context
    expect(LLMContextSummarizationUtil.estimateContextTokens(context)).toEqual(0);

    // Add messages
    context.addMessage({ role: "system", content: "You are helpful" }); // ~4 words
    context.addMessage({ role: "user", content: "Hello" }); // ~1 word
    context.addMessage({ role: "assistant", content: "Hi there" }); // ~2 words

    // Each message has ~10 token overhead
    // Total content: ~7 words * 1.3 = ~9 tokens
    // Total overhead: 3 * 10 = 30 tokens
    // Expected: ~39 tokens
    const total = LLMContextSummarizationUtil.estimateContextTokens(context);
    expect(total).toBeGreaterThan(30); // At least overhead
    expect(total).toBeLessThan(50); // Not too much
  });

  test("test_get_messages_to_summarize_basic", () => {
    const context = new LLMContext();

    // Add messages
    context.addMessage({ role: "system", content: "System prompt" });
    context.addMessage({ role: "user", content: "Message 1" });
    context.addMessage({ role: "assistant", content: "Response 1" });
    context.addMessage({ role: "user", content: "Message 2" });
    context.addMessage({ role: "assistant", content: "Response 2" });
    context.addMessage({ role: "user", content: "Message 3" });
    context.addMessage({ role: "assistant", content: "Response 3" });

    // Keep last 2 messages
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 2);

    // Get first system message from context
    let firstSystem: any = null;
    for (const msg of context.messages as any[]) {
      if (msg.role === "system") {
        firstSystem = msg;
        break;
      }
    }

    // Should get system message
    expect(firstSystem).not.toBeNull();
    expect(firstSystem.content).toEqual("System prompt");

    // Should get middle messages (indices 1-4)
    const messages = result.messages as any[];
    expect(messages.length).toEqual(4);
    expect(messages[0].content).toEqual("Message 1");
    expect(messages[messages.length - 1].content).toEqual("Response 2");

    // Last index should be 4 (0-indexed)
    expect(result.lastSummarizedIndex).toEqual(4);
  });

  test("test_get_messages_to_summarize_no_system", () => {
    const context = new LLMContext();

    // Add messages without system prompt
    context.addMessage({ role: "user", content: "Message 1" });
    context.addMessage({ role: "assistant", content: "Response 1" });
    context.addMessage({ role: "user", content: "Message 2" });
    context.addMessage({ role: "assistant", content: "Response 2" });

    // Keep last 1 message
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 1);

    // Get first system message from context
    let firstSystem: any = null;
    for (const msg of context.messages as any[]) {
      if (msg.role === "system") {
        firstSystem = msg;
        break;
      }
    }

    // Should have no system message
    expect(firstSystem).toBeNull();

    // Should get first 3 messages
    expect(result.messages.length).toEqual(3);
    expect(result.lastSummarizedIndex).toEqual(2);
  });

  test("test_get_messages_to_summarize_insufficient", () => {
    const context = new LLMContext();

    // Add only 2 messages
    context.addMessage({ role: "user", content: "Message 1" });
    context.addMessage({ role: "assistant", content: "Response 1" });

    // Try to keep 2 messages (same as total)
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 2);

    // Should return empty
    expect(result.messages.length).toEqual(0);
    expect(result.lastSummarizedIndex).toEqual(-1);
  });

  test("test_get_messages_to_summarize_mid_conversation_system_message", () => {
    // Regression test for #4286: when the only system message is a
    // mid-conversation injection (not at index 0), getMessagesToSummarize
    // should start from index 0, not after the mid-conversation system message.
    const context = new LLMContext();

    // No system message at index 0 (using system_instruction instead)
    context.addMessage({ role: "user", content: "Hello" });
    context.addMessage({ role: "assistant", content: "Hi there" });
    context.addMessage({ role: "user", content: "Tell me a joke" });
    context.addMessage({ role: "assistant", content: "Why did the chicken..." });
    // Mid-conversation system injection (e.g. "The user has been quiet")
    context.addMessage({ role: "system", content: "The user has been quiet for a while" });
    context.addMessage({ role: "user", content: "Latest message" });
    context.addMessage({ role: "assistant", content: "Latest response" });

    // Keep last 2 messages
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 2);

    // Should summarize from index 0 (no system preamble to skip)
    // through index 4, keeping last 2 messages
    const messages = result.messages as any[];
    expect(messages.length).toEqual(5);
    expect(messages[0].content).toEqual("Hello");
    // The mid-conversation system message should be included in summarization
    expect(messages[4].content).toEqual("The user has been quiet for a while");
    expect(result.lastSummarizedIndex).toEqual(4);
  });

  test("test_get_messages_to_summarize_system_at_index_0_with_mid_system", () => {
    const context = new LLMContext();

    context.addMessage({ role: "system", content: "You are helpful" });
    context.addMessage({ role: "user", content: "Hello" });
    context.addMessage({ role: "assistant", content: "Hi" });
    // Mid-conversation system injection
    context.addMessage({ role: "system", content: "The user seems frustrated" });
    context.addMessage({ role: "user", content: "Help me" });
    context.addMessage({ role: "assistant", content: "Sure" });

    // Keep last 2 messages
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 2);

    // Should skip index 0 (system preamble), summarize indices 1-3
    const messages = result.messages as any[];
    expect(messages.length).toEqual(3);
    expect(messages[0].content).toEqual("Hello");
    // Mid-conversation system message is summarized, not treated as preamble
    expect(messages[2].content).toEqual("The user seems frustrated");
    expect(result.lastSummarizedIndex).toEqual(3);
  });

  test("test_format_messages_for_summary", () => {
    const messages: LLMContextMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];

    const transcript = LLMContextSummarizationUtil.formatMessagesForSummary(messages);

    expect(transcript).toContain("USER: Hello");
    expect(transcript).toContain("ASSISTANT: Hi there");
    expect(transcript).toContain("USER: How are you?");
  });

  test("test_format_messages_with_list_content", () => {
    const messages: LLMContextMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
        ],
      },
    ];

    const transcript = LLMContextSummarizationUtil.formatMessagesForSummary(messages);

    expect(transcript).toContain("USER: First part Second part");
  });
});

describe("TestLLMContextSummaryConfig", () => {
  test("test_default_config", () => {
    const config = new LLMContextSummaryConfig();

    expect(config.targetContextTokens).toEqual(6000);
    expect(config.minMessagesAfterSummary).toEqual(4);
    expect(config.summarizationPrompt).toBeNull();
  });

  test("test_custom_config", () => {
    const config = new LLMContextSummaryConfig({
      targetContextTokens: 2000,
      minMessagesAfterSummary: 4,
      summarizationPrompt: "Custom prompt",
    });

    expect(config.targetContextTokens).toEqual(2000);
    expect(config.minMessagesAfterSummary).toEqual(4);
    expect(config.summaryPrompt).toEqual("Custom prompt");
  });

  test("test_summary_prompt_property", () => {
    const config = new LLMContextSummaryConfig();
    expect(config.summaryPrompt.toLowerCase()).toContain("summarizing a conversation");

    const configWithCustom = new LLMContextSummaryConfig({ summarizationPrompt: "Custom" });
    expect(configWithCustom.summaryPrompt).toEqual("Custom");
  });
});

describe("TestLLMAutoContextSummarizationConfig", () => {
  test("test_default_config", () => {
    const config = new LLMAutoContextSummarizationConfig();

    expect(config.maxContextTokens).toEqual(8000);
    expect(config.maxUnsummarizedMessages).toEqual(20);
    expect(config.summaryConfig.targetContextTokens).toEqual(6000);
    expect(config.summaryConfig.minMessagesAfterSummary).toEqual(4);
  });

  test("test_custom_config", () => {
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 2500,
      maxUnsummarizedMessages: 15,
      summaryConfig: new LLMContextSummaryConfig({
        targetContextTokens: 2000,
        minMessagesAfterSummary: 4,
        summarizationPrompt: "Custom prompt",
      }),
    });

    expect(config.maxContextTokens).toEqual(2500);
    expect(config.maxUnsummarizedMessages).toEqual(15);
    expect(config.summaryConfig.targetContextTokens).toEqual(2000);
    expect(config.summaryConfig.minMessagesAfterSummary).toEqual(4);
    expect(config.summaryConfig.summaryPrompt).toEqual("Custom prompt");
  });

  test("test_target_tokens_auto_adjusted", () => {
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 1000,
      summaryConfig: new LLMContextSummaryConfig({ targetContextTokens: 9000 }),
    });
    expect(config.summaryConfig.targetContextTokens).toBeLessThanOrEqual(
      config.maxContextTokens as number,
    );
  });

  test("test_max_context_tokens_none", () => {
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: null,
      maxUnsummarizedMessages: 20,
    });
    expect(config.maxContextTokens).toBeNull();
    expect(config.maxUnsummarizedMessages).toEqual(20);
  });

  test("test_max_unsummarized_messages_none", () => {
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 8000,
      maxUnsummarizedMessages: null,
    });
    expect(config.maxContextTokens).toEqual(8000);
    expect(config.maxUnsummarizedMessages).toBeNull();
  });

  test("test_both_none_raises", () => {
    // Upstream raises ValueError; the port throws Error.
    let caught: unknown = null;
    try {
      new LLMAutoContextSummarizationConfig({
        maxContextTokens: null,
        maxUnsummarizedMessages: null,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message).toLowerCase()).toContain("at least one");
  });

  test("test_target_tokens_not_auto_adjusted_when_max_none", () => {
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: null,
      maxUnsummarizedMessages: 10,
      summaryConfig: new LLMContextSummaryConfig({ targetContextTokens: 9000 }),
    });
    // targetContextTokens should remain unchanged since there's no max to compare against
    expect(config.summaryConfig.targetContextTokens).toEqual(9000);
  });
});

describe("TestLLMContextSummarizationConfigDeprecated", () => {
  // Deprecated upstream: LLMContextSummarizationConfig is not ported (see
  // docs/CONVENTIONS.md, "Deprecated upstream APIs are not ported").
  test.skip("test_emits_deprecation_warning", () => {});
  // Deprecated upstream: LLMContextSummarizationConfig.to_auto_config is not ported.
  test.skip("test_to_auto_config", () => {});
});

describe("TestFunctionCallHandling", () => {
  test("test_function_call_in_progress_not_summarized", () => {
    const context = new LLMContext();

    // Add messages including a function call without result
    context.addMessage({ role: "system", content: "System prompt" });
    context.addMessage({ role: "user", content: "What time is it?" });
    context.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: { name: "get_time", arguments: "{}" },
        },
      ],
    });
    // No tool result yet - function call is in progress
    context.addMessage({ role: "user", content: "Latest message" });

    // Try to keep last 1 message
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 1);

    // Should only get the first user message, stopping before the function call
    const messages = result.messages as any[];
    expect(messages.length).toEqual(1);
    expect(messages[0].content).toEqual("What time is it?");
    expect(result.lastSummarizedIndex).toEqual(1);
  });

  test("test_completed_function_call_can_be_summarized", () => {
    const context = new LLMContext();

    // Add messages including a complete function call sequence
    context.addMessage({ role: "system", content: "System prompt" });
    context.addMessage({ role: "user", content: "What time is it?" });
    context.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: { name: "get_time", arguments: "{}" },
        },
      ],
    });
    // Tool result completes the function call
    context.addMessage({ role: "tool", tool_call_id: "call_123", content: '{"time": "10:30 AM"}' });
    context.addMessage({ role: "assistant", content: "It's 10:30 AM" });
    context.addMessage({ role: "user", content: "Latest message" });

    // Try to keep last 1 message
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 1);

    // Should get all messages except the last one (complete function call is included)
    const messages = result.messages as any[];
    expect(messages.length).toEqual(4);
    expect(messages[0].content).toEqual("What time is it?");
    expect(messages[messages.length - 1].content).toEqual("It's 10:30 AM");
    expect(result.lastSummarizedIndex).toEqual(4);
  });

  test("test_multiple_function_calls_in_progress", () => {
    const context = new LLMContext();

    // Add messages with multiple function calls
    context.addMessage({ role: "system", content: "System prompt" });
    context.addMessage({ role: "user", content: "Message 1" });
    context.addMessage({ role: "assistant", content: "Response 1" });
    context.addMessage({ role: "user", content: "What's the time and date?" });
    context.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_time",
          type: "function",
          function: { name: "get_time", arguments: "{}" },
        },
        {
          id: "call_date",
          type: "function",
          function: { name: "get_date", arguments: "{}" },
        },
      ],
    });
    // Only one tool result - other call still in progress
    context.addMessage({
      role: "tool",
      tool_call_id: "call_time",
      content: '{"time": "10:30 AM"}',
    });
    context.addMessage({ role: "user", content: "Latest message" });

    // Try to keep last 1 message
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 1);

    // Should stop before the function call that's in progress
    // Messages to summarize: indices 1, 2, 3 (stops before index 4 where incomplete call is)
    expect(result.messages.length).toEqual(3);
    expect(result.lastSummarizedIndex).toEqual(3);
  });

  test("test_multiple_completed_function_calls", () => {
    const context = new LLMContext();

    // Add messages with multiple completed function calls
    context.addMessage({ role: "system", content: "System prompt" });
    context.addMessage({ role: "user", content: "What's the time and date?" });
    context.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_time",
          type: "function",
          function: { name: "get_time", arguments: "{}" },
        },
        {
          id: "call_date",
          type: "function",
          function: { name: "get_date", arguments: "{}" },
        },
      ],
    });
    // Both tool results provided
    context.addMessage({
      role: "tool",
      tool_call_id: "call_time",
      content: '{"time": "10:30 AM"}',
    });
    context.addMessage({
      role: "tool",
      tool_call_id: "call_date",
      content: '{"date": "January 1, 2024"}',
    });
    context.addMessage({ role: "assistant", content: "It's 10:30 AM on January 1, 2024" });
    context.addMessage({ role: "user", content: "Latest message" });

    // Try to keep last 1 message
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 1);

    // Should get all messages except the last one (all function calls completed)
    expect(result.messages.length).toEqual(5);
    expect(result.lastSummarizedIndex).toEqual(5);
  });

  test("test_sequential_function_calls_mixed_completion", () => {
    const context = new LLMContext();

    // Add messages with sequential function calls
    context.addMessage({ role: "system", content: "System prompt" });

    // First function call - completed
    context.addMessage({ role: "user", content: "What time is it?" });
    context.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_time", arguments: "{}" },
        },
      ],
    });
    context.addMessage({ role: "tool", tool_call_id: "call_1", content: '{"time": "10:30 AM"}' });
    context.addMessage({ role: "assistant", content: "It's 10:30 AM" });

    // Second function call - in progress
    context.addMessage({ role: "user", content: "What's the date?" });
    context.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_2",
          type: "function",
          function: { name: "get_date", arguments: "{}" },
        },
      ],
    });
    // No result for call_2 yet
    context.addMessage({ role: "user", content: "Latest message" });

    // Try to keep last 1 message
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 1);

    // Should get messages up to and including the first completed function call
    // but stop before the second function call that's in progress
    // Messages to summarize: indices 1, 2, 3, 4, 5 (stops before index 6 where incomplete call is)
    const messages = result.messages as any[];
    expect(messages.length).toEqual(5);
    expect(messages[messages.length - 1].content).toEqual("What's the date?");
    expect(result.lastSummarizedIndex).toEqual(5);
  });

  test("test_function_call_formatting_in_transcript", () => {
    const messages: LLMContextMessage[] = [
      { role: "user", content: "What time is it?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "get_time", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_123", content: '{"time": "10:30 AM"}' },
      { role: "assistant", content: "It's 10:30 AM" },
    ];

    const transcript = LLMContextSummarizationUtil.formatMessagesForSummary(messages);

    // Check that function call is included
    expect(transcript).toContain("TOOL_CALL: get_time({})");
    // Check that tool result is included
    expect(transcript).toContain('TOOL_RESULT[call_123]: {"time": "10:30 AM"}');
  });

  test("test_no_function_calls", () => {
    const context = new LLMContext();

    // Add normal conversation without function calls
    context.addMessage({ role: "system", content: "System prompt" });
    context.addMessage({ role: "user", content: "Hello" });
    context.addMessage({ role: "assistant", content: "Hi" });
    context.addMessage({ role: "user", content: "How are you?" });
    context.addMessage({ role: "assistant", content: "I'm good" });
    context.addMessage({ role: "user", content: "Latest message" });

    // Try to keep last 1 message
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 1);

    // Should get all messages except the last one
    expect(result.messages.length).toEqual(4);
    expect(result.lastSummarizedIndex).toEqual(4);
  });
});

function threeMessageContext(): LLMContext {
  const context = new LLMContext();
  context.addMessage({ role: "user", content: "Message 1" });
  context.addMessage({ role: "assistant", content: "Response 1" });
  context.addMessage({ role: "user", content: "Message 2" });
  return context;
}

describe("TestSummaryGenerationExceptions", () => {
  test("test_generate_summary_raises_on_no_messages", async () => {
    const llmService = new LLMService();
    const context = new LLMContext();

    // Add only one message (system), which isn't enough to summarize
    context.addMessage({ role: "system", content: "System prompt" });

    const frame = new LLMContextSummaryRequestFrame({
      requestId: "test",
      context,
      minMessagesToKeep: 1,
      targetContextTokens: 1000,
      summarizationPrompt: "Summarize this",
    });

    // Upstream raises RuntimeError; the port throws Error.
    let caught: unknown = null;
    try {
      await svc(llmService)._generateSummary(frame);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toEqual("No messages to summarize");
  });

  test("test_generate_summary_raises_on_no_run_inference", async () => {
    // Create a minimal LLM service - base class raises NotImplementedError
    const llmService = new LLMService();

    const context = threeMessageContext();

    const frame = new LLMContextSummaryRequestFrame({
      requestId: "test",
      context,
      minMessagesToKeep: 1,
      targetContextTokens: 1000,
      summarizationPrompt: "Summarize this",
    });

    let caught: unknown = null;
    try {
      await svc(llmService)._generateSummary(frame);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("does not implement run_inference");
    expect((caught as Error).message).toContain("LLMService");
  });

  test("test_generate_summary_raises_on_empty_response", async () => {
    const llmService = new LLMService();
    // Mock runInference to return null
    svc(llmService).runInference = mock(async () => null);

    const context = threeMessageContext();

    const frame = new LLMContextSummaryRequestFrame({
      requestId: "test",
      context,
      minMessagesToKeep: 1,
      targetContextTokens: 1000,
      summarizationPrompt: "Summarize this",
    });

    let caught: unknown = null;
    try {
      await svc(llmService)._generateSummary(frame);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toEqual("LLM returned empty summary");
  });

  test("test_generate_summary_task_handles_exceptions", async () => {
    const llmService = new LLMService();

    // Mock broadcastFrame to capture the result
    const broadcastCalls: [unknown, any][] = [];

    svc(llmService).broadcastFrame = async (frameClass: unknown, options: any) => {
      broadcastCalls.push([frameClass, options]);
    };

    // Mock pushError
    const pushError = mock(async (..._args: unknown[]) => {});
    svc(llmService).pushError = pushError;

    const context = new LLMContext();
    context.addMessage({ role: "system", content: "System prompt" });

    const frame = new LLMContextSummaryRequestFrame({
      requestId: "test_123",
      context,
      minMessagesToKeep: 1,
      targetContextTokens: 1000,
      summarizationPrompt: "Summarize this",
    });

    // Execute the task
    await svc(llmService)._generateSummaryTask(frame);

    // Verify broadcastFrame was called with error
    expect(broadcastCalls.length).toEqual(1);
    const [, kwargs] = broadcastCalls[0]!;
    expect(kwargs.requestId).toEqual("test_123");
    expect(kwargs.summary).toEqual("");
    expect(kwargs.lastSummarizedIndex).toEqual(-1);
    expect(kwargs.error).toEqual("Error generating context summary: No messages to summarize");

    // Verify pushError was called
    expect(pushError).toHaveBeenCalledTimes(1);
  });

  test("test_generate_summary_success", async () => {
    const llmService = new LLMService();
    // Mock runInference to return a summary
    svc(llmService).runInference = mock(async () => "This is a summary of the conversation");

    const context = threeMessageContext();

    const frame = new LLMContextSummaryRequestFrame({
      requestId: "test",
      context,
      minMessagesToKeep: 1,
      targetContextTokens: 1000,
      summarizationPrompt: "Summarize this",
    });

    const [summary, lastIndex] = await svc(llmService)._generateSummary(frame);

    expect(summary).toEqual("This is a summary of the conversation");
    expect(lastIndex).toBeGreaterThan(-1);
    expect(lastIndex).toEqual(1); // Should be the index of the last summarized message
  });

  test("test_generate_summary_task_timeout", async () => {
    const llmService = new LLMService();

    // Mock _generateSummary to hang
    svc(llmService)._generateSummary = async (_frame: unknown) => {
      await sleep(10);
      return ["summary", 1];
    };

    const broadcastCalls: [unknown, any][] = [];

    svc(llmService).broadcastFrame = async (frameClass: unknown, options: any) => {
      broadcastCalls.push([frameClass, options]);
    };
    const pushError = mock(async (..._args: unknown[]) => {});
    svc(llmService).pushError = pushError;

    const context = threeMessageContext();

    const frame = new LLMContextSummaryRequestFrame({
      requestId: "timeout_test",
      context,
      minMessagesToKeep: 1,
      targetContextTokens: 1000,
      summarizationPrompt: "Summarize this",
      summarizationTimeout: 0.1, // Very short timeout
    });

    await svc(llmService)._generateSummaryTask(frame);

    // Should have broadcast an error result
    expect(broadcastCalls.length).toEqual(1);
    const [, kwargs] = broadcastCalls[0]!;
    expect(kwargs.requestId).toEqual("timeout_test");
    expect(kwargs.summary).toEqual("");
    expect(kwargs.lastSummarizedIndex).toEqual(-1);
    // error is null for timeout path (pushError is called instead)
    expect(kwargs.error).toBeNull();

    // pushError should have been called with timeout message
    expect(pushError).toHaveBeenCalledTimes(1);
    const errorMsg = pushError.mock.calls[0]![0] as string;
    expect(errorMsg).toContain("timed out");
  });
});

describe("TestDedicatedLLMSummarization", () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  /** Create a context with enough messages and a config with a dedicated LLM. */
  function createContextAndConfig(
    dedicatedLlm: LLMService,
  ): [LLMContext, LLMAutoContextSummarizationConfig] {
    const context = new LLMContext();
    for (let i = 0; i < 10; i++) {
      context.addMessage({
        role: "user",
        content: `Test message ${i} that adds tokens to context.`,
      });
    }

    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50, // Very low to trigger easily
      summaryConfig: new LLMContextSummaryConfig({
        llm: dedicatedLlm,
        summarizationTimeout: 5.0,
      }),
    });
    return [context, config];
  }

  test("test_dedicated_llm_success", async () => {
    const dedicatedLlm = new LLMService();
    const generateSummary = mock(async (_frame: unknown) => ["Dedicated summary", 5]);
    svc(dedicatedLlm)._generateSummary = generateSummary;

    const [context, config] = createContextAndConfig(dedicatedLlm);
    const originalMessageCount = context.messages.length;
    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    // Track whether on_request_summarization event fires (it should NOT)
    let eventFired = false;

    summarizer.eventHandler("on_request_summarization", async (_summarizer, _frame) => {
      eventFired = true;
    });

    // Trigger summarization via LLM response start
    await summarizer.processFrame(new LLMFullResponseStartFrame());

    // Wait for the background task to complete
    await sleep(0.1);

    // The event should NOT have fired (dedicated LLM handles it internally)
    expect(eventFired).toBe(false);

    // Verify the dedicated LLM was called
    expect(generateSummary).toHaveBeenCalledTimes(1);

    // Verify summary was applied to context (message count should decrease)
    expect(context.messages.length).toBeLessThan(originalMessageCount);

    // Verify summary message is present
    const summaryMessages = (context.messages as any[]).filter((msg) =>
      String(msg.content ?? "").includes("Conversation summary:"),
    );
    expect(summaryMessages.length).toEqual(1);
    expect(summaryMessages[0].content).toContain("Dedicated summary");

    await summarizer.cleanup();
  });

  test("test_dedicated_llm_timeout", async () => {
    const dedicatedLlm = new LLMService();

    svc(dedicatedLlm)._generateSummary = async (_frame: unknown) => {
      await sleep(10);
      return ["summary", 1];
    };

    const [context, config] = createContextAndConfig(dedicatedLlm);
    config.summaryConfig.summarizationTimeout = 0.1; // Very short timeout
    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    const originalMessageCount = context.messages.length;

    // Trigger summarization
    await summarizer.processFrame(new LLMFullResponseStartFrame());

    // Wait for the background task to complete (timeout + some buffer)
    await sleep(0.3);

    // Context should be unchanged (timeout = error = no summary applied)
    expect(context.messages.length).toEqual(originalMessageCount);

    // Summarization state should be cleared so new requests can be made
    expect(summ(summarizer)._summarizationInProgress).toBe(false);

    await summarizer.cleanup();
  });

  test("test_dedicated_llm_exception", async () => {
    const dedicatedLlm = new LLMService();
    svc(dedicatedLlm)._generateSummary = mock(async (_frame: unknown) => {
      throw new Error("LLM connection failed");
    });

    const [context, config] = createContextAndConfig(dedicatedLlm);
    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    const originalMessageCount = context.messages.length;

    // Trigger summarization
    await summarizer.processFrame(new LLMFullResponseStartFrame());

    // Wait for the background task to complete
    await sleep(0.1);

    // Context should be unchanged (exception = error = no summary applied)
    expect(context.messages.length).toEqual(originalMessageCount);

    // Summarization state should be cleared
    expect(summ(summarizer)._summarizationInProgress).toBe(false);

    await summarizer.cleanup();
  });

  test("test_dedicated_llm_does_not_emit_event", async () => {
    const dedicatedLlm = new LLMService();
    svc(dedicatedLlm)._generateSummary = mock(async (_frame: unknown) => ["Summary", 1]);

    const [context, config] = createContextAndConfig(dedicatedLlm);
    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let eventFired = false;

    summarizer.eventHandler("on_request_summarization", async (_summarizer, _frame) => {
      eventFired = true;
    });

    await summarizer.processFrame(new LLMFullResponseStartFrame());
    await sleep(0.1);

    expect(eventFired).toBe(false);

    await summarizer.cleanup();
  });

  test("test_no_dedicated_llm_emits_event", async () => {
    const context = new LLMContext();
    for (let i = 0; i < 10; i++) {
      context.addMessage({
        role: "user",
        content: `Test message ${i} that adds tokens to context.`,
      });
    }

    const config = new LLMAutoContextSummarizationConfig({ maxContextTokens: 50 });
    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: unknown = null;

    summarizer.eventHandler("on_request_summarization", async (_summarizer, frame) => {
      requestFrame = frame;
    });

    await summarizer.processFrame(new LLMFullResponseStartFrame());

    expect(requestFrame).not.toBeNull();
    expect(requestFrame).toBeInstanceOf(LLMContextSummaryRequestFrame);

    await summarizer.cleanup();
  });
});

/**
 * Tests that tool responses in the kept range are treated as orphans.
 *
 * The scan in _getEarliestFunctionCallNotResolvedInRange is bounded by
 * summaryEnd, so a tool response that falls in the kept portion (>= summaryEnd)
 * never resolves its matching tool call. This ensures the assistant+tool_calls
 * message and all its responses stay together in the kept range.
 */
describe("TestOrphanedToolResponseDetection", () => {
  test("test_tool_response_in_kept_range_is_treated_as_orphan", () => {
    const context = new LLMContext();
    context.addMessage({ role: "system", content: "System prompt" }); // idx 0
    context.addMessage({ role: "user", content: "Hello" }); // idx 1
    context.addMessage({
      // idx 2: assistant with tool_call
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "fn", arguments: "{}" } }],
    });
    context.addMessage({ role: "tool", tool_call_id: "call_1", content: "result" }); // idx 3 (kept)
    context.addMessage({ role: "user", content: "Thanks" }); // idx 4 (kept)

    // Keep 2: summaryEnd=3. The tool response at idx 3 is outside the scan
    // range → call_1 stays pending → boundary moves back to idx 2.
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 2);
    const messages = result.messages as any[];
    expect(result.lastSummarizedIndex).toEqual(1);
    expect(messages[messages.length - 1].content).toEqual("Hello");
  });

  test("test_tool_response_in_summarized_range_is_not_orphan", () => {
    const context = new LLMContext();
    context.addMessage({ role: "system", content: "System prompt" }); // idx 0
    context.addMessage({ role: "user", content: "Hello" }); // idx 1
    context.addMessage({
      // idx 2: assistant with tool_call
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "fn", arguments: "{}" } }],
    });
    context.addMessage({ role: "tool", tool_call_id: "call_1", content: "result" }); // idx 3
    context.addMessage({ role: "assistant", content: "Done" }); // idx 4
    context.addMessage({ role: "user", content: "Thanks" }); // idx 5 (kept)

    // Keep 1: summaryEnd=5. Both the tool call (idx 2) and its response
    // (idx 3) are within the scan range → resolved → no adjustment.
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 1);
    expect(result.lastSummarizedIndex).toEqual(4);
    expect(result.messages.length).toEqual(4);
  });

  test("test_partial_responses_in_kept_range_moves_back", () => {
    const context = new LLMContext();
    context.addMessage({ role: "system", content: "System prompt" }); // idx 0
    context.addMessage({ role: "user", content: "Hello" }); // idx 1
    context.addMessage({
      // idx 2: assistant with two tool_calls
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "fn_a", arguments: "{}" } },
        { id: "call_b", type: "function", function: { name: "fn_b", arguments: "{}" } },
      ],
    });
    context.addMessage({ role: "tool", tool_call_id: "call_a", content: "result_a" }); // idx 3
    context.addMessage({ role: "tool", tool_call_id: "call_b", content: "result_b" }); // idx 4 (kept)
    context.addMessage({ role: "user", content: "Thanks" }); // idx 5 (kept)

    // Keep 2: summaryEnd=4. call_a is resolved (idx 3 is in scan range) but
    // call_b's response (idx 4) is outside → call_b stays pending →
    // functionCallStart=2 → boundary moves back to idx 2.
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 2);
    const messages = result.messages as any[];
    expect(result.lastSummarizedIndex).toEqual(1);
    expect(messages[messages.length - 1].content).toEqual("Hello");
  });

  test("test_non_adjacent_orphan_in_kept_range_moves_back", () => {
    const context = new LLMContext();
    context.addMessage({ role: "system", content: "System prompt" }); // idx 0
    context.addMessage({ role: "user", content: "Hello" }); // idx 1
    context.addMessage({
      // idx 2: assistant with two tool_calls
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "fn_a", arguments: "{}" } },
        { id: "call_b", type: "function", function: { name: "fn_b", arguments: "{}" } },
      ],
    });
    context.addMessage({ role: "tool", tool_call_id: "call_a", content: "result_a" }); // idx 3
    context.addMessage({ role: "user", content: "Intermediate" }); // idx 4 (kept)
    // idx 5 (kept) — NOT adjacent to the boundary
    context.addMessage({ role: "tool", tool_call_id: "call_b", content: "result_b" });
    context.addMessage({ role: "user", content: "Latest" }); // idx 6 (kept)

    // Keep 3: summaryEnd=4. call_b's response is at idx 5, two hops into
    // the kept range. The scan stops at idx 4, so call_b is never resolved →
    // functionCallStart=2 → boundary moves back to idx 2.
    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 3);
    const messages = result.messages as any[];
    expect(result.lastSummarizedIndex).toEqual(1);
    expect(messages[messages.length - 1].content).toEqual("Hello");
  });
});

describe("TestLLMSpecificMessageHandling", () => {
  test("test_estimate_context_tokens_skips_specific_messages", () => {
    const context = new LLMContext();
    context.addMessage({ role: "user", content: "Hello" });
    context.addMessage(new LLMSpecificMessage({ llm: "google", message: {} }));
    context.addMessage({ role: "assistant", content: "Hi there" });

    const tokensWithSpecific = LLMContextSummarizationUtil.estimateContextTokens(context);

    const contextWithout = new LLMContext();
    contextWithout.addMessage({ role: "user", content: "Hello" });
    contextWithout.addMessage({ role: "assistant", content: "Hi there" });
    const tokensWithout = LLMContextSummarizationUtil.estimateContextTokens(contextWithout);

    expect(tokensWithSpecific).toEqual(tokensWithout);
  });

  test("test_get_messages_to_summarize_with_specific_messages", () => {
    const context = new LLMContext();
    context.addMessage({ role: "system", content: "System prompt" });
    context.addMessage(new LLMSpecificMessage({ llm: "google", message: {} }));
    context.addMessage({ role: "user", content: "Message 1" });
    context.addMessage({ role: "assistant", content: "Response 1" });
    context.addMessage(new LLMSpecificMessage({ llm: "google", message: {} }));
    context.addMessage({ role: "user", content: "Message 2" });
    context.addMessage({ role: "assistant", content: "Response 2" });

    const result = LLMContextSummarizationUtil.getMessagesToSummarize(context, 2);

    expect(result.messages.length).toEqual(4);
    expect(result.lastSummarizedIndex).toEqual(4);
  });

  test("test_format_messages_skips_specific_messages", () => {
    const messages: LLMContextMessage[] = [
      { role: "user", content: "Hello" },
      new LLMSpecificMessage({ llm: "google", message: {} }),
      { role: "assistant", content: "Hi there" },
    ];

    const transcript = LLMContextSummarizationUtil.formatMessagesForSummary(messages);

    expect(transcript).toContain("USER: Hello");
    expect(transcript).toContain("ASSISTANT: Hi there");
  });

  test("test_function_call_tracking_skips_specific_messages", () => {
    const messages: LLMContextMessage[] = [
      { role: "user", content: "What time is it?" },
      new LLMSpecificMessage({ llm: "google", message: {} }),
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "get_time", arguments: "{}" },
          },
        ],
      },
      new LLMSpecificMessage({ llm: "google", message: {} }),
      { role: "tool", tool_call_id: "call_123", content: '{"time": "10:30 AM"}' },
    ];

    const result = Util._getEarliestFunctionCallNotResolvedInRange(messages, 0, messages.length);
    expect(result).toEqual(-1);
  });
});
