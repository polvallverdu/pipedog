// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_context_summarizer.py

import { beforeEach, describe, expect, test } from "bun:test";

import { sleep } from "@pipecat-ts/asyncio";

import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  InterruptionFrame,
  LLMContextSummaryRequestFrame,
  LLMContextSummaryResultFrame,
  LLMFullResponseStartFrame,
  LLMSummarizeContextFrame,
} from "../src/frames/frames.ts";
import { LLMContext, type LLMContextMessage } from "../src/processors/aggregators/llm_context.ts";
import {
  LLMContextSummarizer,
  SummaryAppliedEvent,
} from "../src/processors/aggregators/llm_context_summarizer.ts";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";
import {
  LLMAutoContextSummarizationConfig,
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

/** Python `msg.get("content", "")`. */
function contentOf(msg: LLMContextMessage): string {
  const content = (msg as Record<string, unknown>).content;
  return (content ?? "") as string;
}

describe("TestLLMContextSummarizer", () => {
  let taskManager: TaskManager;
  let context: LLMContext;

  beforeEach(() => {
    taskManager = new TaskManager();

    context = new LLMContext({
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    });
  });

  test("test_summarization_triggered_by_token_limit", async () => {
    // Test that summarization is triggered when token limit is reached.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 100, // Very low to trigger easily
      maxUnsummarizedMessages: 100, // High so it doesn't trigger by message count
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    // Add messages to exceed token limit
    for (let i = 0; i < 10; i++) {
      context.addMessage({
        role: "user",
        content: "This is a test message that adds tokens to the context.",
      });
    }

    // Trigger check by processing LLMFullResponseStartFrame
    await summarizer.processFrame(new LLMFullResponseStartFrame());

    // Should have triggered summarization
    expect(requestFrame).not.toBeNull();
    expect(requestFrame).toBeInstanceOf(LLMContextSummaryRequestFrame);
    expect(requestFrame!.context).toBe(context);

    await summarizer.cleanup();
  });

  test("test_summarization_triggered_by_message_count", async () => {
    // Test that summarization is triggered when message count threshold is reached.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 100000, // Very high so it doesn't trigger by tokens
      maxUnsummarizedMessages: 5, // Low to trigger easily
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    // Add messages to exceed message count
    for (let i = 0; i < 6; i++) {
      context.addMessage({ role: "user", content: `Message ${i}` });
    }

    // Trigger check
    await summarizer.processFrame(new LLMFullResponseStartFrame());

    // Should have triggered summarization
    expect(requestFrame).not.toBeNull();
    expect(requestFrame).toBeInstanceOf(LLMContextSummaryRequestFrame);

    await summarizer.cleanup();
  });

  test("test_summarization_not_triggered_below_thresholds", async () => {
    // Test that summarization is not triggered when below thresholds.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 10000,
      maxUnsummarizedMessages: 20,
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    // Add a few messages (below threshold)
    for (let i = 0; i < 3; i++) {
      context.addMessage({ role: "user", content: "Short message" });
    }

    // Trigger check
    await summarizer.processFrame(new LLMFullResponseStartFrame());

    // Should NOT have triggered summarization
    expect(requestFrame).toBeNull();

    await summarizer.cleanup();
  });

  test("test_summarization_in_progress_prevents_duplicate", async () => {
    // Test that a summarization in progress prevents triggering another.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50, // Very low
      maxUnsummarizedMessages: 100,
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestCount = 0;

    summarizer.eventHandler("on_request_summarization", async () => {
      requestCount += 1;
    });

    // Add enough messages to trigger
    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message to add tokens." });
    }

    // First trigger - should request summarization
    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestCount).toEqual(1);

    // Second trigger while first is in progress - should NOT request again
    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestCount).toEqual(1);

    await summarizer.cleanup();
  });

  test("test_summary_result_handling", async () => {
    // Test that summary results are processed and applied correctly.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50,
      summaryConfig: new LLMContextSummaryConfig({ minMessagesAfterSummary: 2 }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    // Add messages and trigger summarization
    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message." });
    }

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    const originalMessageCount = context.messages.length;
    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestFrame).not.toBeNull();

    // Simulate receiving a summary result
    const summaryResult = new LLMContextSummaryResultFrame({
      requestId: requestFrame!.requestId,
      summary: "This is a test summary.",
      lastSummarizedIndex: 5,
      error: null,
    });

    await summarizer.processFrame(summaryResult);

    // Should have applied the summary and reduced message count
    // Expected: system message + summary message + 2 recent messages = 4 messages
    // (since last_summarized_index=5, we keep messages after index 5)
    expect(context.messages.length).toBeLessThan(originalMessageCount);

    // Check that summary was added
    const summaryMessages = context.messages.filter((msg) =>
      contentOf(msg).includes("Conversation summary:"),
    );
    expect(summaryMessages.length).toEqual(1);

    await summarizer.cleanup();
  });

  test("test_interruption_cancels_summarization", async () => {
    // Test that an interruption cancels pending summarization.
    const config = new LLMAutoContextSummarizationConfig({ maxContextTokens: 50 });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    // Add messages and trigger summarization
    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message." });
    }

    let requestCount = 0;

    summarizer.eventHandler("on_request_summarization", async () => {
      requestCount += 1;
    });

    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestCount).toEqual(1);

    // Process interruption
    await summarizer.processFrame(new InterruptionFrame());

    // Try to trigger again - should work since the previous one was canceled
    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestCount).toEqual(2);

    await summarizer.cleanup();
  });

  test("test_stale_summary_result_ignored", async () => {
    // Test that stale summary results are ignored.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50,
      summaryConfig: new LLMContextSummaryConfig({ minMessagesAfterSummary: 2 }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    // Add messages and trigger summarization
    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message." });
    }

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    const originalMessageCount = context.messages.length;
    await summarizer.processFrame(new LLMFullResponseStartFrame());
    const validRequestId = requestFrame!.requestId;

    // Send a stale summary result (wrong request_id)
    const staleResult = new LLMContextSummaryResultFrame({
      requestId: "stale-id-123",
      summary: "Stale summary",
      lastSummarizedIndex: 3,
      error: null,
    });

    await summarizer.processFrame(staleResult);

    // Should be ignored - message count should not change
    expect(context.messages.length).toEqual(originalMessageCount);

    // Send the correct summary result
    const validResult = new LLMContextSummaryResultFrame({
      requestId: validRequestId,
      summary: "Valid summary",
      lastSummarizedIndex: 5,
      error: null,
    });

    await summarizer.processFrame(validResult);

    // Should be processed - message count should decrease
    expect(context.messages.length).toBeLessThan(originalMessageCount);

    // Check that summary was added
    const summaryMessages = context.messages.filter((msg) =>
      contentOf(msg).includes("Conversation summary:"),
    );
    expect(summaryMessages.length).toEqual(1);

    await summarizer.cleanup();
  });

  test("test_manual_summarization_via_frame", async () => {
    // Test that LLMSummarizeContextFrame triggers summarization on demand.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 100000, // High — auto trigger would never fire
      maxUnsummarizedMessages: 100,
    });

    const summarizer = new LLMContextSummarizer({
      context,
      config,
      autoTrigger: false, // Disable auto; only manual requests should work
    });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    // Add messages
    for (let i = 0; i < 5; i++) {
      context.addMessage({ role: "user", content: `Message ${i}` });
    }

    // Auto-trigger should NOT fire even on LLMFullResponseStartFrame
    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestFrame).toBeNull();

    // Manual trigger via LLMSummarizeContextFrame should fire
    await summarizer.processFrame(new LLMSummarizeContextFrame());
    expect(requestFrame).not.toBeNull();
    expect(requestFrame).toBeInstanceOf(LLMContextSummaryRequestFrame);

    // The request must have a valid request_id and carry the current context
    expect(requestFrame!.requestId).toBeTruthy();
    expect(requestFrame!.context).toBe(context);

    await summarizer.cleanup();
  });

  test("test_manual_summarization_with_config_override", async () => {
    // Test that LLMSummarizeContextFrame can override default summary config.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 100000,
      summaryConfig: new LLMContextSummaryConfig({
        targetContextTokens: 6000,
        minMessagesAfterSummary: 4,
      }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    for (let i = 0; i < 5; i++) {
      context.addMessage({ role: "user", content: `Message ${i}` });
    }

    // Push a manual frame with custom config overrides
    const customConfig = new LLMContextSummaryConfig({
      targetContextTokens: 500,
      minMessagesAfterSummary: 1,
    });
    await summarizer.processFrame(new LLMSummarizeContextFrame({ config: customConfig }));

    expect(requestFrame).not.toBeNull();
    // The request should use the overridden values
    expect(requestFrame!.targetContextTokens).toEqual(500);
    expect(requestFrame!.minMessagesToKeep).toEqual(1);

    await summarizer.cleanup();
  });

  test("test_manual_summarization_blocked_when_in_progress", async () => {
    // Test that a second LLMSummarizeContextFrame is ignored while one is in progress.
    const config = new LLMAutoContextSummarizationConfig({ maxContextTokens: 100000 });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestCount = 0;

    summarizer.eventHandler("on_request_summarization", async () => {
      requestCount += 1;
    });

    for (let i = 0; i < 5; i++) {
      context.addMessage({ role: "user", content: `Message ${i}` });
    }

    // First manual request
    await summarizer.processFrame(new LLMSummarizeContextFrame());
    expect(requestCount).toEqual(1);

    // Second manual request while first is in progress — should be ignored
    await summarizer.processFrame(new LLMSummarizeContextFrame());
    expect(requestCount).toEqual(1);

    await summarizer.cleanup();
  });

  test("test_summary_message_role_is_user", async () => {
    // Test that the summary message uses the user role.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50,
      summaryConfig: new LLMContextSummaryConfig({ minMessagesAfterSummary: 2 }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    // Add messages and trigger summarization
    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message." });
    }

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestFrame).not.toBeNull();

    // Simulate receiving a summary result
    const summaryResult = new LLMContextSummaryResultFrame({
      requestId: requestFrame!.requestId,
      summary: "This is a test summary.",
      lastSummarizedIndex: 5,
    });
    await summarizer.processFrame(summaryResult);

    // Find the summary message and verify its role is "user"
    const summaryMsg =
      context.messages.find((msg) => contentOf(msg).toLowerCase().includes("summary")) ?? null;
    expect(summaryMsg).not.toBeNull();
    expect((summaryMsg as Record<string, unknown>).role).toEqual("user");

    await summarizer.cleanup();
  });

  test("test_summary_message_default_template", async () => {
    // Test that the default summary_message_template is used.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50,
      summaryConfig: new LLMContextSummaryConfig({ minMessagesAfterSummary: 2 }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message." });
    }

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    await summarizer.processFrame(new LLMFullResponseStartFrame());

    const summaryResult = new LLMContextSummaryResultFrame({
      requestId: requestFrame!.requestId,
      summary: "Key facts from conversation.",
      lastSummarizedIndex: 5,
    });
    await summarizer.processFrame(summaryResult);

    // Default template wraps with "Conversation summary: {summary}"
    const summaryMsg =
      context.messages.find((msg) => contentOf(msg).includes("Conversation summary:")) ?? null;
    expect(summaryMsg).not.toBeNull();
    expect(contentOf(summaryMsg!)).toEqual("Conversation summary: Key facts from conversation.");

    await summarizer.cleanup();
  });

  test("test_summary_message_custom_template", async () => {
    // Test that a custom summary_message_template is applied.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50,
      summaryConfig: new LLMContextSummaryConfig({
        minMessagesAfterSummary: 2,
        summaryMessageTemplate: "<context_summary>\n{summary}\n</context_summary>",
      }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message." });
    }

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    await summarizer.processFrame(new LLMFullResponseStartFrame());

    const summaryResult = new LLMContextSummaryResultFrame({
      requestId: requestFrame!.requestId,
      summary: "Key facts from conversation.",
      lastSummarizedIndex: 5,
    });
    await summarizer.processFrame(summaryResult);

    // Custom template wraps with XML tags
    const summaryMsg =
      context.messages.find((msg) => contentOf(msg).includes("<context_summary>")) ?? null;
    expect(summaryMsg).not.toBeNull();
    expect(contentOf(summaryMsg!)).toEqual(
      "<context_summary>\nKey facts from conversation.\n</context_summary>",
    );

    await summarizer.cleanup();
  });

  test("test_on_summary_applied_event", async () => {
    // Test that on_summary_applied event fires with correct data.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50,
      summaryConfig: new LLMContextSummaryConfig({ minMessagesAfterSummary: 2 }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    // Add messages (1 system + 10 user = 11 total)
    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message." });
    }

    let requestFrame: LLMContextSummaryRequestFrame | null = null;
    let appliedEvent: SummaryAppliedEvent | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    summarizer.eventHandler(
      "on_summary_applied",
      async (_summarizer, event: SummaryAppliedEvent) => {
        appliedEvent = event;
      },
    );

    const originalCount = context.messages.length; // 11
    await summarizer.processFrame(new LLMFullResponseStartFrame());

    // Summarize up to index 7 (system=0, user1..user7), keep last 3 (user8, user9, user10)
    const summaryResult = new LLMContextSummaryResultFrame({
      requestId: requestFrame!.requestId,
      summary: "Test summary.",
      lastSummarizedIndex: 7,
    });
    await summarizer.processFrame(summaryResult);

    // Allow async event handler to complete
    await sleep(0.05);

    // Verify event was fired
    expect(appliedEvent).not.toBeNull();
    expect(appliedEvent).toBeInstanceOf(SummaryAppliedEvent);
    const event = appliedEvent as unknown as SummaryAppliedEvent;
    expect(event.originalMessageCount).toEqual(originalCount);

    // After summarization: system + summary + 3 recent = 5
    expect(event.newMessageCount).toEqual(5);

    // Summarized messages: indices 1-7 = 7 messages (excluding system at index 0)
    expect(event.summarizedMessageCount).toEqual(7);

    // Preserved: system (1) + recent messages after index 7 (3) = 4
    expect(event.preservedMessageCount).toEqual(4);

    await summarizer.cleanup();
  });

  test("test_on_summary_applied_not_fired_on_error", async () => {
    // Test that on_summary_applied event is NOT fired when summarization fails.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50,
      summaryConfig: new LLMContextSummaryConfig({ minMessagesAfterSummary: 2 }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message." });
    }

    let requestFrame: LLMContextSummaryRequestFrame | null = null;
    let appliedEvent: SummaryAppliedEvent | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    summarizer.eventHandler(
      "on_summary_applied",
      async (_summarizer, event: SummaryAppliedEvent) => {
        appliedEvent = event;
      },
    );

    await summarizer.processFrame(new LLMFullResponseStartFrame());

    // Send a result with an error
    const errorResult = new LLMContextSummaryResultFrame({
      requestId: requestFrame!.requestId,
      summary: "",
      lastSummarizedIndex: -1,
      error: "Summarization timed out",
    });
    await summarizer.processFrame(errorResult);

    await sleep(0.05);

    // Event should NOT have fired
    expect(appliedEvent).toBeNull();

    await summarizer.cleanup();
  });

  test("test_request_frame_includes_timeout", async () => {
    // Test that the request frame includes the configured summarization_timeout.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 50,
      summaryConfig: new LLMContextSummaryConfig({ summarizationTimeout: 60.0 }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "Test message to add tokens." });
    }

    await summarizer.processFrame(new LLMFullResponseStartFrame());

    expect(requestFrame).not.toBeNull();
    expect(requestFrame!.summarizationTimeout).toEqual(60.0);

    await summarizer.cleanup();
  });

  test("test_token_limit_none_only_message_threshold", async () => {
    // Test that only message threshold triggers when token limit is None.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: null,
      maxUnsummarizedMessages: 5,
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    // Add many tokens but fewer than 5 messages — should NOT trigger
    for (let i = 0; i < 3; i++) {
      context.addMessage({ role: "user", content: "x".repeat(10000) }); // Lots of tokens
    }

    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestFrame).toBeNull();

    // Cross the message threshold (5 messages since summary = 6 total including system)
    for (let i = 0; i < 3; i++) {
      context.addMessage({ role: "user", content: `Message ${i}` });
    }

    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestFrame).not.toBeNull();

    await summarizer.cleanup();
  });

  test("test_message_limit_none_only_token_threshold", async () => {
    // Test that only token threshold triggers when message limit is None.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 100, // Very low
      maxUnsummarizedMessages: null,
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    // Add many messages that exceed the token limit
    for (let i = 0; i < 10; i++) {
      context.addMessage({ role: "user", content: "This is a test message with enough tokens." });
    }

    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestFrame).not.toBeNull();

    await summarizer.cleanup();
  });

  test("test_message_limit_none_no_trigger_below_tokens", async () => {
    // Test that many messages don't trigger when message limit is None and tokens are low.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 100000, // Very high
      maxUnsummarizedMessages: null,
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    // Add many short messages — would exceed any reasonable message count
    // but tokens stay well below the limit
    for (let i = 0; i < 50; i++) {
      context.addMessage({ role: "user", content: `Msg ${i}` });
    }

    await summarizer.processFrame(new LLMFullResponseStartFrame());

    // Should NOT trigger because token limit is not exceeded
    expect(requestFrame).toBeNull();

    await summarizer.cleanup();
  });

  /** Run one threshold check and report whether a summary was requested. */
  async function checkTrigger(summarizer: LLMContextSummarizer): Promise<boolean> {
    let requested = false;

    summarizer.eventHandler("on_request_summarization", async () => {
      requested = true;
    });

    await summarizer.processFrame(new LLMFullResponseStartFrame());
    return requested;
  }

  test("test_message_count_excludes_system_message_only_when_present", async () => {
    // The message threshold counts conversation messages, not the system message.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 100000,
      maxUnsummarizedMessages: 5,
    });

    // With a leading system message, 5 conversation messages trigger.
    let summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));
    for (let i = 0; i < 4; i++) {
      context.addMessage({ role: "user", content: `Message ${i}` });
    }
    expect(await checkTrigger(summarizer)).toBe(false);
    context.addMessage({ role: "user", content: "Message 4" });
    expect(await checkTrigger(summarizer)).toBe(true);
    await summarizer.cleanup();

    // Without one, 5 conversation messages still trigger.
    const context2 = new LLMContext();
    summarizer = new LLMContextSummarizer({ context: context2, config });
    await summarizer.setup(frameProcessorSetup(taskManager));
    for (let i = 0; i < 4; i++) {
      context2.addMessage({ role: "user", content: `Message ${i}` });
    }
    expect(await checkTrigger(summarizer)).toBe(false);
    context2.addMessage({ role: "user", content: "Message 4" });
    expect(await checkTrigger(summarizer)).toBe(true);
    await summarizer.cleanup();
  });

  test("test_message_count_resets_after_summary", async () => {
    // After a summary, only messages added since it count toward the threshold.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 100000,
      maxUnsummarizedMessages: 5,
      summaryConfig: new LLMContextSummaryConfig({ minMessagesAfterSummary: 2 }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    for (let i = 0; i < 5; i++) {
      context.addMessage({ role: "user", content: `Message ${i}` });
    }
    await summarizer.processFrame(new LLMFullResponseStartFrame());
    expect(requestFrame).not.toBeNull();

    // Summarize messages 1..3, keeping the last two. The context becomes
    // [system, summary, Message 3, Message 4].
    await summarizer.processFrame(
      new LLMContextSummaryResultFrame({
        requestId: requestFrame!.requestId,
        summary: "Summary.",
        lastSummarizedIndex: 3,
      }),
    );
    expect(context.messages.length).toEqual(4);

    // Two kept messages plus two new ones is below the threshold of five.
    for (let i = 0; i < 2; i++) {
      context.addMessage({ role: "user", content: `New message ${i}` });
    }
    expect(await checkTrigger(summarizer)).toBe(false);

    // The fifth conversation message since the summary triggers again.
    context.addMessage({ role: "user", content: "New message 2" });
    expect(await checkTrigger(summarizer)).toBe(true);

    await summarizer.cleanup();
  });

  test("test_message_count_resets_when_context_replaced", async () => {
    // Replacing the context after a summary drops the summary from the count.
    const config = new LLMAutoContextSummarizationConfig({
      maxContextTokens: 100000,
      maxUnsummarizedMessages: 5,
      summaryConfig: new LLMContextSummaryConfig({ minMessagesAfterSummary: 2 }),
    });

    const summarizer = new LLMContextSummarizer({ context, config });
    await summarizer.setup(frameProcessorSetup(taskManager));

    let requestFrame: LLMContextSummaryRequestFrame | null = null;

    summarizer.eventHandler(
      "on_request_summarization",
      async (_summarizer, frame: LLMContextSummaryRequestFrame) => {
        requestFrame = frame;
      },
    );

    for (let i = 0; i < 5; i++) {
      context.addMessage({ role: "user", content: `Message ${i}` });
    }
    await summarizer.processFrame(new LLMFullResponseStartFrame());
    await summarizer.processFrame(
      new LLMContextSummaryResultFrame({
        requestId: requestFrame!.requestId,
        summary: "Summary.",
        lastSummarizedIndex: 3,
      }),
    );

    // A fresh conversation with no summary message: every message counts.
    context.setMessages([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Message 0" },
      { role: "user", content: "Message 1" },
      { role: "user", content: "Message 2" },
      { role: "user", content: "Message 3" },
    ]);
    expect(await checkTrigger(summarizer)).toBe(false);
    context.addMessage({ role: "user", content: "Message 4" });
    expect(await checkTrigger(summarizer)).toBe(true);

    await summarizer.cleanup();
  });
});
