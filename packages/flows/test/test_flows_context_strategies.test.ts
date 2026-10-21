// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_flows_context_strategies.py

/**
 * Test suite for context management strategies.
 *
 * This module contains tests for the context management features of Flows,
 * focusing on:
 * - Context strategy configuration
 * - Strategy behavior (APPEND, RESET, RESET_WITH_SUMMARY)
 * - Provider-specific message formatting
 * - Summary generation and integration
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AnthropicLLMService } from "@pipedog/anthropic/llm";
import { TimeoutError } from "@pipedog/asyncio";
import {
  type Frame,
  LLMMessagesAppendFrame,
  LLMMessagesUpdateFrame,
  LLMSetToolsFrame,
  LLMUpdateSettingsFrame,
} from "@pipedog/core/frames/frames";
import type { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { _warnedSites } from "@pipedog/core/utils/deprecation";
import { FlowManager } from "@pipedog/flows/manager";
import { ContextStrategy, ContextStrategyConfig, type NodeConfig } from "@pipedog/flows/types";
import { GoogleLLMService } from "@pipedog/google/llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { captureLogs, getQueuedFramesBatches, type MockWorker } from "./flows_test_helpers.ts";

describe("TestContextStrategies", () => {
  let mockWorker: MockWorker;
  let mockLlm: OpenAILLMService;
  let runInference: ReturnType<typeof mock>;
  let mockContext: { messages: Record<string, unknown>[]; getMessages: () => unknown[] };
  let mockContextAggregator: any;
  let sampleNode: NodeConfig;

  beforeEach(() => {
    mockWorker = {
      queueFrame: mock(async () => {}),
      queueFrames: mock(async () => {}),
      setReachedDownstreamFilter: mock(() => {}),
      eventHandler: mock(() => {}),
    } as unknown as MockWorker;

    // Set up mock LLM with client
    mockLlm = new OpenAILLMService({ apiKey: "test-key" });
    runInference = mock(async () => null as string | null);
    (mockLlm as any).runInference = runInference;

    // Create mock context aggregator with messages
    mockContext = {
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
      getMessages: () => mockContext.messages,
    };

    mockContextAggregator = {
      user: () => ({ context: mockContext as unknown as LLMContext }),
      assistant: () => ({ hasFunctionCallsInProgress: false }),
    };

    // Sample node configuration
    sampleNode = {
      taskMessages: [{ role: "developer", content: "Test task." }],
      functions: [],
    };
  });

  /** The frames of the first `queueFrames` call since the last reset. */
  const firstBatch = (): Frame[] => getQueuedFramesBatches(mockWorker)[0]!;

  test("test_context_strategy_config_validation", () => {
    // Valid configurations
    new ContextStrategyConfig({ strategy: ContextStrategy.APPEND });
    new ContextStrategyConfig({ strategy: ContextStrategy.RESET });
    new ContextStrategyConfig({
      strategy: ContextStrategy.RESET_WITH_SUMMARY,
      summaryPrompt: "Summarize the conversation",
    });

    // Invalid configuration - missing prompt
    expect(
      () => new ContextStrategyConfig({ strategy: ContextStrategy.RESET_WITH_SUMMARY }),
    ).toThrow(Error);
  });

  test("test_reset_with_summary_deprecation_warning", async () => {
    runInference.mockImplementation(async () => "Conversation summary");
    _warnedSites.clear();

    const flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
      contextStrategy: new ContextStrategyConfig({
        strategy: ContextStrategy.RESET_WITH_SUMMARY,
        summaryPrompt: "Summarize the conversation",
      }),
    });
    await flowManager.initialize();

    // First node using RESET_WITH_SUMMARY should trigger the deprecation warning
    let warnings = await captureLogs(() => flowManager._setNode("first", sampleNode));
    let deprecations = warnings.filter((w) => w.message.includes("DeprecationWarning"));
    expect(deprecations.length).toBeGreaterThanOrEqual(1);
    expect(deprecations[0]!.message).toContain("`RESET_WITH_SUMMARY` is deprecated");

    // Second node should NOT trigger a second warning (once-only)
    mockWorker.queueFrames.mockClear();
    warnings = await captureLogs(() => flowManager._setNode("second", sampleNode));
    deprecations = warnings.filter((w) => w.message.includes("DeprecationWarning"));
    expect(deprecations.length).toBe(0);
  });

  test("test_default_strategy", async () => {
    const flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
    });
    await flowManager.initialize();

    // Under the default (APPEND) strategy the first node appends, keeping any
    // context already present.
    await flowManager._setNode("first", sampleNode);
    const firstFrames = firstBatch();
    expect(firstFrames.some((f) => f instanceof LLMMessagesAppendFrame)).toBe(true);
    expect(firstFrames.some((f) => f instanceof LLMMessagesUpdateFrame)).toBe(false);

    // Reset mock
    mockWorker.queueFrames.mockClear();

    // Subsequent node should use AppendFrame with default strategy
    await flowManager._setNode("second", sampleNode);
    expect(firstBatch().some((f) => f instanceof LLMMessagesAppendFrame)).toBe(true);
  });

  test("test_reset_strategy", async () => {
    const flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
      contextStrategy: new ContextStrategyConfig({ strategy: ContextStrategy.RESET }),
    });
    await flowManager.initialize();

    // First node should use UpdateFrame under the RESET strategy
    await flowManager._setNode("first", sampleNode);
    expect(firstBatch().some((f) => f instanceof LLMMessagesUpdateFrame)).toBe(true);
    mockWorker.queueFrames.mockClear();

    // Second node should use UpdateFrame with RESET strategy
    await flowManager._setNode("second", sampleNode);
    expect(firstBatch().some((f) => f instanceof LLMMessagesUpdateFrame)).toBe(true);
  });

  test("test_context_and_tools_frames_are_uninterruptible", async () => {
    for (const [strategy, frameType] of [
      [ContextStrategy.APPEND, LLMMessagesAppendFrame],
      [ContextStrategy.RESET, LLMMessagesUpdateFrame],
    ] as const) {
      const flowManager = new FlowManager({
        worker: mockWorker as any,
        llm: mockLlm,
        contextAggregator: mockContextAggregator,
        contextStrategy: new ContextStrategyConfig({ strategy }),
      });
      await flowManager.initialize();
      mockWorker.queueFrames.mockClear();

      await flowManager._setNode("node", sampleNode);
      const checked = firstBatch().filter(
        (f) => f instanceof frameType || f instanceof LLMSetToolsFrame,
      );
      expect(checked.length).toBe(2);
      expect(checked.every((f) => !f.interruptible)).toBe(true);
    }
  });

  test("test_reset_with_summary_success", async () => {
    // Mock successful summary generation
    const mockSummary = "Conversation summary";
    runInference.mockImplementation(async () => mockSummary);

    const flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
      contextStrategy: new ContextStrategyConfig({
        strategy: ContextStrategy.RESET_WITH_SUMMARY,
        summaryPrompt: "Summarize the conversation",
      }),
    });
    await flowManager.initialize();

    // Set nodes and verify summary inclusion
    await flowManager._setNode("first", sampleNode);
    mockWorker.queueFrames.mockClear();

    await flowManager._setNode("second", sampleNode);

    // Verify summary was included in context update
    const updateFrame = firstBatch().find(
      (f): f is LLMMessagesUpdateFrame => f instanceof LLMMessagesUpdateFrame,
    )!;
    expect(updateFrame.messages.some((m) => JSON.stringify(m).includes(mockSummary))).toBe(true);
  });

  test("test_reset_with_summary_timeout", async () => {
    const flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
      contextStrategy: new ContextStrategyConfig({
        strategy: ContextStrategy.RESET_WITH_SUMMARY,
        summaryPrompt: "Summarize the conversation",
      }),
    });
    await flowManager.initialize();

    // Mock timeout
    runInference.mockImplementation(async () => {
      throw new TimeoutError();
    });

    // Set nodes and verify fallback to APPEND
    await flowManager._setNode("first", sampleNode);
    mockWorker.queueFrames.mockClear();

    await flowManager._setNode("second", sampleNode);

    // Verify AppendFrame was used (APPEND behavior)
    expect(firstBatch().some((f) => f instanceof LLMMessagesAppendFrame)).toBe(true);
  });

  test("test_provider_specific_summary_formatting", () => {
    const summary = "Test summary";

    // Test OpenAI format
    let flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: new OpenAILLMService({ apiKey: "test-key" }),
      contextAggregator: mockContextAggregator,
    });
    expect(flowManager._adapter.formatSummaryMessage(summary).role).toBe("developer");

    // Test Anthropic format
    flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: new AnthropicLLMService({ apiKey: "test-key" }),
      contextAggregator: mockContextAggregator,
    });
    expect(flowManager._adapter.formatSummaryMessage(summary).role).toBe("developer");

    // Test Gemini format
    flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: new GoogleLLMService({ apiKey: " " }), // dummy key (GoogleLLMService rejects empty string)
      contextAggregator: mockContextAggregator,
    });
    expect(flowManager._adapter.formatSummaryMessage(summary).role).toBe("developer");
  });

  test("test_node_level_strategy_override", async () => {
    const flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
      contextStrategy: new ContextStrategyConfig({ strategy: ContextStrategy.APPEND }),
    });
    await flowManager.initialize();

    // Create node with RESET strategy
    const nodeWithStrategy: NodeConfig = {
      ...sampleNode,
      contextStrategy: new ContextStrategyConfig({ strategy: ContextStrategy.RESET }),
    };

    // Set nodes and verify strategy override
    await flowManager._setNode("first", sampleNode);
    mockWorker.queueFrames.mockClear();

    await flowManager._setNode("second", nodeWithStrategy);

    // Verify UpdateFrame was used (RESET behavior) despite global APPEND
    expect(firstBatch().some((f) => f instanceof LLMMessagesUpdateFrame)).toBe(true);
  });

  test("test_summary_generation_content", async () => {
    runInference.mockImplementation(async () => "Generated summary");

    const summaryPrompt = "Create a detailed summary";
    const flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
      contextStrategy: new ContextStrategyConfig({
        strategy: ContextStrategy.RESET_WITH_SUMMARY,
        summaryPrompt,
      }),
    });
    await flowManager.initialize();

    // Set nodes to trigger summary generation
    await flowManager._setNode("first", sampleNode);
    await flowManager._setNode("second", sampleNode);

    // Verify summary generation call
    const [context, options] = runInference.mock.calls.at(-1) as [LLMContext, any];

    // Verify summary prompt was passed as the system instruction
    expect(options.systemInstruction).toBe(summaryPrompt);

    // Verify conversation history was included in context messages
    expect(
      context
        .getMessages()
        .some((m) => JSON.stringify(m).includes(String(mockContext.messages[0]!.content))),
    ).toBe(true);
  });

  test("test_context_structure_after_summary", async () => {
    const mockSummary = "Generated summary";
    runInference.mockImplementation(async () => mockSummary);

    const flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
      contextStrategy: new ContextStrategyConfig({
        strategy: ContextStrategy.RESET_WITH_SUMMARY,
        summaryPrompt: "Summarize",
      }),
    });
    await flowManager.initialize();

    // Set nodes to trigger summary generation
    await flowManager._setNode("first", sampleNode);
    mockWorker.queueFrames.mockClear();

    // Node with new task messages
    const newNode: NodeConfig = {
      taskMessages: [{ role: "developer", content: "New task." }],
      functions: [],
    };
    await flowManager._setNode("second", newNode);

    // Verify context structure
    const messagesFrame = firstBatch().find(
      (f): f is LLMMessagesUpdateFrame => f instanceof LLMMessagesUpdateFrame,
    )!;

    // Verify order: summary message, then new task messages
    expect(JSON.stringify(messagesFrame.messages[0])).toContain(mockSummary);
    expect((messagesFrame.messages[1] as any).content).toBe(newNode.taskMessages[0]!.content);
  });

  test("test_reset_with_summary_and_role_messages", async () => {
    const mockSummary = "Conversation summary";
    runInference.mockImplementation(async () => mockSummary);

    const flowManager = new FlowManager({
      worker: mockWorker as any,
      llm: mockLlm,
      contextAggregator: mockContextAggregator,
      contextStrategy: new ContextStrategyConfig({
        strategy: ContextStrategy.RESET_WITH_SUMMARY,
        summaryPrompt: "Summarize the conversation",
      }),
    });
    await flowManager.initialize();

    // Set first node (with roleMessage)
    await flowManager._setNode("first", {
      roleMessage: "You are a helpful assistant.",
      taskMessages: [{ role: "developer", content: "First task." }],
      functions: [],
    });
    mockWorker.queueFrames.mockClear();

    // Set second node with roleMessage — triggers summary + settings update
    await flowManager._setNode("second", {
      roleMessage: "You are now a different assistant.",
      taskMessages: [{ role: "developer", content: "Second task." }],
      functions: [],
    });

    const secondFrames = firstBatch();

    // Verify LLMUpdateSettingsFrame is present with new system instruction
    const settingsFrames = secondFrames.filter(
      (f): f is LLMUpdateSettingsFrame => f instanceof LLMUpdateSettingsFrame,
    );
    expect(settingsFrames.length).toBe(1);
    expect(settingsFrames[0]!.delta!.systemInstruction).toBe("You are now a different assistant.");

    // Verify UpdateFrame contains summary + task messages
    const updateFrames = secondFrames.filter(
      (f): f is LLMMessagesUpdateFrame => f instanceof LLMMessagesUpdateFrame,
    );
    expect(updateFrames.length).toBe(1);
    const messages = updateFrames[0]!.messages as any[];
    expect(JSON.stringify(messages[0])).toContain(mockSummary);
    expect(messages[1].content).toBe("Second task.");

    // Verify frame ordering: LLMUpdateSettingsFrame before LLMMessagesUpdateFrame
    expect(secondFrames.indexOf(settingsFrames[0]!)).toBeLessThan(
      secondFrames.indexOf(updateFrames[0]!),
    );
  });
});
