// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_mute_strategy.py

import { describe, expect, test } from "bun:test";

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  ErrorFrame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
  InterruptionFrame,
} from "../src/frames/frames.ts";
import {
  AlwaysUserMuteStrategy,
  FirstSpeechUserMuteStrategy,
  FunctionCallUserMuteStrategy,
  MuteUntilFirstBotCompleteUserMuteStrategy,
} from "../src/turns/user_mute/index.ts";

function functionCall(functionName: string, toolCallId: string): FunctionCallFromLLM {
  return new FunctionCallFromLLM({ functionName, toolCallId, arguments: {}, context: null });
}

describe("TestAlwaysUserMuteStrategy", () => {
  test("test_user_mute_strategy", async () => {
    const strategy = new AlwaysUserMuteStrategy();

    expect(await strategy.processFrame(new BotStartedSpeakingFrame())).toBe(true);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    expect(await strategy.processFrame(new BotStoppedSpeakingFrame())).toBe(false);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);
  });
});

describe("TestFirstSpeechUserMuteStrategy", () => {
  test("test_user_mute_strategy", async () => {
    const strategy = new FirstSpeechUserMuteStrategy();

    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);
    expect(await strategy.processFrame(new BotStartedSpeakingFrame())).toBe(true);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    expect(await strategy.processFrame(new BotStoppedSpeakingFrame())).toBe(false);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);
  });
});

describe("TestMuteUntilFirstBotCompleteUserMuteStrategy", () => {
  test("test_user_mute_strategy", async () => {
    const strategy = new MuteUntilFirstBotCompleteUserMuteStrategy();

    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    expect(await strategy.processFrame(new BotStartedSpeakingFrame())).toBe(true);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    expect(await strategy.processFrame(new BotStoppedSpeakingFrame())).toBe(false);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);
  });

  test("test_error_before_first_speech", async () => {
    const strategy = new MuteUntilFirstBotCompleteUserMuteStrategy();

    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    expect(await strategy.processFrame(new ErrorFrame({ error: "TTS failed" }))).toBe(false);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);
  });

  test("test_error_while_bot_speaking", async () => {
    const strategy = new MuteUntilFirstBotCompleteUserMuteStrategy();

    expect(await strategy.processFrame(new BotStartedSpeakingFrame())).toBe(true);
    expect(await strategy.processFrame(new ErrorFrame({ error: "TTS failed" }))).toBe(true);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    expect(await strategy.processFrame(new BotStoppedSpeakingFrame())).toBe(false);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);
  });
});

describe("TestFunctionCallUserMuteStrategy", () => {
  test("test_user_mute_strategy", async () => {
    const strategy = new FunctionCallUserMuteStrategy();

    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);
    // First function call (cancelled)
    expect(
      await strategy.processFrame(
        new FunctionCallsStartedFrame({ functionCalls: [functionCall("fn_1", "1")] }),
      ),
    ).toBe(true);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    expect(
      await strategy.processFrame(
        new FunctionCallCancelFrame({ functionName: "fn_1", toolCallId: "1" }),
      ),
    ).toBe(false);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);

    // Second function call (finished)
    expect(
      await strategy.processFrame(
        new FunctionCallsStartedFrame({ functionCalls: [functionCall("fn_2", "2")] }),
      ),
    ).toBe(true);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    expect(
      await strategy.processFrame(
        new FunctionCallResultFrame({
          functionName: "fn_2",
          toolCallId: "2",
          arguments: {},
          result: {},
        }),
      ),
    ).toBe(false);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);

    // Multiple function calls
    expect(
      await strategy.processFrame(
        new FunctionCallsStartedFrame({
          functionCalls: [functionCall("fn_3", "3"), functionCall("fn_4", "4")],
        }),
      ),
    ).toBe(true);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    // First function call is done, we still should be muted since there's
    // another one ongoing.
    expect(
      await strategy.processFrame(
        new FunctionCallResultFrame({
          functionName: "fn_3",
          toolCallId: "3",
          arguments: {},
          result: {},
        }),
      ),
    ).toBe(true);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(true);
    // Last function call finishes.
    expect(
      await strategy.processFrame(
        new FunctionCallResultFrame({
          functionName: "fn_4",
          toolCallId: "4",
          arguments: {},
          result: {},
        }),
      ),
    ).toBe(false);
    expect(await strategy.processFrame(new InterruptionFrame())).toBe(false);
  });

  /**
   * A tool call id can be reported as finished more than once, e.g. an
   * async tool emitting an intermediate update and then its final result.
   */
  test("test_repeated_result_frame_stays_unmuted", async () => {
    const strategy = new FunctionCallUserMuteStrategy();

    expect(
      await strategy.processFrame(
        new FunctionCallsStartedFrame({ functionCalls: [functionCall("fn", "1")] }),
      ),
    ).toBe(true);
    const result = new FunctionCallResultFrame({
      functionName: "fn",
      toolCallId: "1",
      arguments: {},
      result: {},
    });
    expect(await strategy.processFrame(result)).toBe(false);
    expect(await strategy.processFrame(result)).toBe(false);
  });

  /**
   * Result and cancel frames can arrive for a tool call id that never
   * appeared in a started frame, e.g. the built-in cancel tool.
   */
  test("test_unknown_tool_call_id_stays_unmuted", async () => {
    const strategy = new FunctionCallUserMuteStrategy();

    expect(
      await strategy.processFrame(
        new FunctionCallCancelFrame({ functionName: "fn", toolCallId: "unknown" }),
      ),
    ).toBe(false);
    expect(
      await strategy.processFrame(
        new FunctionCallResultFrame({
          functionName: "fn",
          toolCallId: "unknown",
          arguments: {},
          result: {},
        }),
      ),
    ).toBe(false);
  });

  /** An unknown id must not disturb the calls that are still running. */
  test("test_unknown_tool_call_id_leaves_other_calls_muted", async () => {
    const strategy = new FunctionCallUserMuteStrategy();

    expect(
      await strategy.processFrame(
        new FunctionCallsStartedFrame({ functionCalls: [functionCall("fn", "1")] }),
      ),
    ).toBe(true);
    expect(
      await strategy.processFrame(
        new FunctionCallResultFrame({
          functionName: "other",
          toolCallId: "unknown",
          arguments: {},
          result: {},
        }),
      ),
    ).toBe(true);
    expect(
      await strategy.processFrame(
        new FunctionCallResultFrame({
          functionName: "fn",
          toolCallId: "1",
          arguments: {},
          result: {},
        }),
      ),
    ).toBe(false);
  });
});
