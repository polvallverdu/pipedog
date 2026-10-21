// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_flows_actions.py

/**
 * Test suite for ActionManager functionality.
 *
 * This module tests the ActionManager class which handles execution of actions
 * during conversation flows. Tests cover:
 * - Built-in actions (TTS, end conversation)
 * - Custom action registration and execution
 * - Error handling and validation
 * - Action sequencing
 * - Frame queueing
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import { ActionManager } from "@pipedog/flows/actions";
import { ActionError } from "@pipedog/flows/exceptions";
import type { ActionConfig } from "@pipedog/flows/types";
import {
  assertEndFrameQueued,
  assertTtsSpeakFramesQueued,
  captureLogs,
  getQueuedTtsSpeakFrames,
  type MockWorker,
  makeMockWorker,
} from "./flows_test_helpers.ts";

describe("TestActionManager", () => {
  let mockWorker: MockWorker;
  let mockFlowManager: any;
  let actionManager: ActionManager;

  beforeEach(() => {
    mockWorker = makeMockWorker();
    mockFlowManager = { state: {} };
    actionManager = new ActionManager(mockWorker as any, mockFlowManager);
  });

  test("test_initialization", () => {
    // Verify built-in action handlers are registered
    expect(actionManager._actionHandlers.has("tts_say")).toBe(true);
    expect(actionManager._actionHandlers.has("end_conversation")).toBe(true);
  });

  test("test_tts_action", async () => {
    await actionManager.executeActions([{ type: "tts_say", text: "Hello" }]);
    assertTtsSpeakFramesQueued(mockWorker, ["Hello"]);
  });

  test("test_end_conversation_action", async () => {
    await actionManager.executeActions([{ type: "end_conversation" }]);

    // Verify EndFrame was queued
    assertEndFrameQueued(mockWorker);
  });

  test("test_end_conversation_with_goodbye", async () => {
    await actionManager.executeActions([{ type: "end_conversation", text: "Goodbye!" }]);

    // Verify TTSSpeakFrame
    assertTtsSpeakFramesQueued(mockWorker, ["Goodbye!"]);

    // Verify EndFrame
    assertEndFrameQueued(mockWorker);
  });

  test("test_tts_action_append_text_to_context", async () => {
    // Explicitly true
    await actionManager.executeActions([
      { type: "tts_say", text: "Hello", appendTextToContext: true },
    ]);
    let frames = getQueuedTtsSpeakFrames(mockWorker);
    expect(frames.length).toBe(1);
    expect(frames[0]!.appendToContext).toBe(true);

    // Explicitly false
    mockWorker.queueFrame.mockClear();
    await actionManager.executeActions([
      { type: "tts_say", text: "Hello", appendTextToContext: false },
    ]);
    frames = getQueuedTtsSpeakFrames(mockWorker);
    expect(frames.length).toBe(1);
    expect(frames[0]!.appendToContext).toBe(false);

    // Omitted: Flows applies its own default of true.
    mockWorker.queueFrame.mockClear();
    const warnings = await captureLogs(() =>
      actionManager.executeActions([{ type: "tts_say", text: "Hello" }]),
    );
    frames = getQueuedTtsSpeakFrames(mockWorker);
    expect(frames.length).toBe(1);
    expect(frames[0]!.appendToContext).toBe(true);
    expect(warnings.filter((w) => w.message.includes("append_to_context"))).toEqual([]);
  });

  test("test_end_conversation_append_text_to_context", async () => {
    // Explicitly false
    await actionManager.executeActions([
      { type: "end_conversation", text: "Goodbye!", appendTextToContext: false },
    ]);
    let frames = getQueuedTtsSpeakFrames(mockWorker);
    expect(frames.length).toBe(1);
    expect(frames[0]!.appendToContext).toBe(false);
    assertEndFrameQueued(mockWorker);

    // Explicitly true
    mockWorker.queueFrame.mockClear();
    await actionManager.executeActions([
      { type: "end_conversation", text: "Goodbye!", appendTextToContext: true },
    ]);
    frames = getQueuedTtsSpeakFrames(mockWorker);
    expect(frames.length).toBe(1);
    expect(frames[0]!.appendToContext).toBe(true);

    // Omitted: Flows applies its own default of true.
    mockWorker.queueFrame.mockClear();
    const warnings = await captureLogs(() =>
      actionManager.executeActions([{ type: "end_conversation", text: "Goodbye!" }]),
    );
    frames = getQueuedTtsSpeakFrames(mockWorker);
    expect(frames.length).toBe(1);
    expect(frames[0]!.appendToContext).toBe(true);
    expect(warnings.filter((w) => w.message.includes("append_to_context"))).toEqual([]);
  });

  test("test_function_actions", async () => {
    const results: string[] = [];

    async function firstFunction(_action: ActionConfig, _flowManager: unknown) {
      results.push("first_start");
      await sleep(0.25);
      results.push("first_end");
    }

    async function secondFunction(_action: ActionConfig, _flowManager: unknown) {
      results.push("second_start");
      results.push("second_end");
    }

    await actionManager.executeActions([
      { type: "function", handler: firstFunction },
      { type: "function", handler: secondFunction },
    ]);

    // Validate the order
    expect(results).toEqual(["first_start", "first_end", "second_start", "second_end"]);
  });

  test("test_action_handler_signatures", async () => {
    // A handler that only takes the action
    let legacyCalled = false;
    actionManager._registerAction("legacy", async (action: ActionConfig) => {
      expect(action.data).toBe("legacy");
      legacyCalled = true;
    });
    await actionManager.executeActions([{ type: "legacy", data: "legacy" }]);
    expect(legacyCalled).toBe(true);

    // A handler that takes the action and the flow manager
    let modernCalled = false;
    actionManager._registerAction("modern", async (action: ActionConfig, flowManager: unknown) => {
      expect(action.data).toBe("modern");
      expect(flowManager).toBe(mockFlowManager);
      modernCalled = true;
    });
    await actionManager.executeActions([{ type: "modern", data: "modern" }]);
    expect(modernCalled).toBe(true);
  });

  test("test_invalid_action", async () => {
    // Test missing type
    const missingType = actionManager.executeActions([{} as ActionConfig]);
    await expect(missingType).rejects.toThrow(ActionError);
    await expect(actionManager.executeActions([{} as ActionConfig])).rejects.toThrow(
      "missing required 'type' field",
    );

    // Test unknown action type
    await expect(actionManager.executeActions([{ type: "invalid" }])).rejects.toThrow(
      "No handler registered",
    );
  });

  test("test_multiple_actions", async () => {
    await actionManager.executeActions([
      { type: "tts_say", text: "First" },
      { type: "tts_say", text: "Second" },
    ]);

    // Verify TTS was called twice in correct order
    assertTtsSpeakFramesQueued(mockWorker, ["First", "Second"]);
  });

  test("test_register_invalid_handler", () => {
    // Test non-callable handler
    expect(() => actionManager._registerAction("invalid", "not_callable" as any)).toThrow(
      "must be callable",
    );

    // Test null handler
    expect(() => actionManager._registerAction("invalid", null as any)).toThrow("must be callable");
  });

  test("test_none_or_empty_actions", async () => {
    // Test null actions
    await actionManager.executeActions(null);
    expect(mockWorker.queueFrame).not.toHaveBeenCalled();

    // Test empty list
    await actionManager.executeActions([]);
    expect(mockWorker.queueFrame).not.toHaveBeenCalled();
  });

  test("test_action_error_handling", async () => {
    // Configure worker mock to raise an error
    mockWorker.queueFrame.mockImplementation(async () => {
      throw new Error("Frame error");
    });

    const errors = await captureLogs(
      () => actionManager.executeActions([{ type: "tts_say", text: "Hello" }]),
      "ERROR",
    );

    // Verify error was logged
    expect(errors.at(-1)?.message).toBe("TTS error: Frame error");
  });

  test("test_action_execution_error_handling", async () => {
    const manager = new ActionManager(mockWorker as any, mockFlowManager);

    // Test action with missing handler
    await expect(manager.executeActions([{ type: "nonexistent_action" }])).rejects.toThrow(
      ActionError,
    );

    // Test action handler that raises an exception
    manager._registerAction(
      "failing_action",
      mock(async () => {
        throw new Error("Handler error");
      }),
    );

    await expect(manager.executeActions([{ type: "failing_action" }])).rejects.toThrow(ActionError);
  });
});
