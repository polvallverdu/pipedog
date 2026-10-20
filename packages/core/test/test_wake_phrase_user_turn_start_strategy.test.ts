// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_wake_phrase_user_turn_start_strategy.py

import { describe, expect, test } from "bun:test";

import { sleep } from "@pipedog/asyncio";

import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  BotSpeakingFrame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
  UserSpeakingFrame,
  VADUserStartedSpeakingFrame,
} from "../src/frames/frames.ts";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import { ProcessFrameResult } from "../src/turns/types.ts";
import {
  _WakeState,
  WakePhraseUserTurnStartStrategy,
  type WakePhraseUserTurnStartStrategyOptions,
} from "../src/turns/user_start/wake_phrase_user_turn_start_strategy.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";

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

describe("TestWakePhraseUserTurnStartStrategy", () => {
  function createStrategy(
    options: Partial<WakePhraseUserTurnStartStrategyOptions> = {},
  ): WakePhraseUserTurnStartStrategy {
    return new WakePhraseUserTurnStartStrategy({
      phrases: ["hey pipecat"],
      timeout: 10.0,
      ...options,
    });
  }

  async function setupStrategy(strategy: WakePhraseUserTurnStartStrategy): Promise<TaskManager> {
    const taskManager = new TaskManager();
    await strategy.setup(frameProcessorSetup(taskManager));
    // The tests are quick, so make sure the schedule starts all tasks.
    await sleep(0);
    return taskManager;
  }

  test("test_wake_phrase_in_final_transcription", async () => {
    const strategy = createStrategy();
    await setupStrategy(strategy);

    const result = await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    await strategy.cleanup();
  });

  test("test_interim_transcription_ignored", async () => {
    // Interim transcriptions are never used for wake phrase matching.
    const strategy = createStrategy();
    await setupStrategy(strategy);

    const result = await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.IDLE);

    await strategy.cleanup();
  });

  test("test_no_wake_phrase_returns_stop", async () => {
    const strategy = createStrategy();
    await setupStrategy(strategy);

    const result = await strategy.processFrame(
      new TranscriptionFrame({ text: "hello world", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.IDLE);

    await strategy.cleanup();
  });

  test("test_non_matching_text_resets_aggregation", async () => {
    // Non-matching transcription triggers aggregation reset to prevent LLM context pollution.
    const strategy = createStrategy();
    await setupStrategy(strategy);

    let resetCalled = false;

    strategy.eventHandler("on_reset_aggregation", async (_strategy) => {
      resetCalled = true;
    });

    await strategy.processFrame(
      new TranscriptionFrame({ text: "hello world", userId: "user1", timestamp: "" }),
    );
    expect(resetCalled).toBe(true);

    await strategy.cleanup();
  });

  test("test_vad_frame_returns_stop_in_listening", async () => {
    const strategy = createStrategy();
    await setupStrategy(strategy);

    const result = await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.IDLE);

    await strategy.cleanup();
  });

  test("test_inactive_returns_continue", async () => {
    const strategy = createStrategy();
    await setupStrategy(strategy);

    // Trigger wake phrase first.
    await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    // Subsequent frames should return CONTINUE.
    let result = await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(result).toEqual(ProcessFrameResult.CONTINUE);

    result = await strategy.processFrame(
      new TranscriptionFrame({ text: "what is the weather", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.CONTINUE);

    await strategy.cleanup();
  });

  test("test_accumulation_across_frames", async () => {
    const strategy = createStrategy();
    await setupStrategy(strategy);

    let result = await strategy.processFrame(
      new TranscriptionFrame({ text: "hey", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.IDLE);

    result = await strategy.processFrame(
      new TranscriptionFrame({ text: "pipecat", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    await strategy.cleanup();
  });

  test("test_multiple_phrases", async () => {
    const strategy = createStrategy({ phrases: ["hey pipecat", "ok computer"] });
    await setupStrategy(strategy);

    const result = await strategy.processFrame(
      new TranscriptionFrame({ text: "ok computer", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    await strategy.cleanup();
  });

  test("test_punctuation_stripped", async () => {
    // STT punctuation like 'Hey, Pipecat!' should still match.
    const strategy = createStrategy();
    await setupStrategy(strategy);

    const result = await strategy.processFrame(
      new TranscriptionFrame({ text: "Hey, Pipecat!", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    await strategy.cleanup();
  });

  test("test_turn_start_preserves_inactive_state", async () => {
    const strategy = createStrategy();
    await setupStrategy(strategy);

    await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    await strategy.handleUserTurnStarted();
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    await strategy.cleanup();
  });

  test("test_timeout_returns_to_listening", async () => {
    const strategy = createStrategy({ timeout: 0.1 });
    await setupStrategy(strategy);

    // Trigger wake phrase.
    await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    // Wait for timeout to expire.
    await sleep(0.3);

    expect(strategy.state).toEqual(_WakeState.IDLE);

    await strategy.cleanup();
  });

  test("test_activity_refreshes_timeout", async () => {
    const strategy = createStrategy({ timeout: 0.2 });
    await setupStrategy(strategy);

    // Trigger wake phrase.
    await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    // Send activity before timeout.
    await sleep(0.1);
    await strategy.processFrame(new UserSpeakingFrame());
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    // Send more activity.
    await sleep(0.1);
    await strategy.processFrame(new BotSpeakingFrame());
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    // Wait for timeout to expire after last activity.
    await sleep(0.3);
    expect(strategy.state).toEqual(_WakeState.IDLE);

    await strategy.cleanup();
  });

  test("test_wake_phrase_detected_event", async () => {
    const strategy = createStrategy();
    await setupStrategy(strategy);

    let detectedPhrase: string | null = null;

    strategy.eventHandler("on_wake_phrase_detected", async (_strategy, phrase: string) => {
      detectedPhrase = phrase;
    });

    await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );

    // Event fires in a background task, give it a moment.
    await sleep(0.05);
    expect(detectedPhrase as string | null).toEqual("hey pipecat");

    await strategy.cleanup();
  });

  test("test_wake_phrase_timeout_event", async () => {
    const strategy = createStrategy({ timeout: 0.1 });
    await setupStrategy(strategy);

    let timeoutFired = false;

    strategy.eventHandler("on_wake_phrase_timeout", async (_strategy) => {
      timeoutFired = true;
    });

    await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );

    // Wait for timeout.
    await sleep(0.3);
    expect(timeoutFired).toBe(true);

    await strategy.cleanup();
  });

  test("test_single_activation_stays_inactive_after_turn_start", async () => {
    // In single activation mode, the turn-start callback keeps INACTIVE so the current turn can finish.
    const strategy = createStrategy({ singleActivation: true, timeout: 0.5 });
    await setupStrategy(strategy);

    // Trigger wake phrase.
    let result = await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    // Simulate turn start (the controller notifies all start strategies).
    await strategy.handleUserTurnStarted();
    // State remains INACTIVE so frames continue to flow.
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    // Subsequent frames should pass through (CONTINUE).
    result = await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(result).toEqual(ProcessFrameResult.CONTINUE);

    result = await strategy.processFrame(
      new TranscriptionFrame({ text: "what is the weather", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.CONTINUE);

    await strategy.cleanup();
  });

  test("test_single_activation_timeout_returns_to_listening", async () => {
    // In single activation mode, the keepalive timeout returns to LISTENING.
    const strategy = createStrategy({ singleActivation: true, timeout: 0.1 });
    await setupStrategy(strategy);

    // Trigger wake phrase.
    await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    // Wait for keepalive timeout to expire.
    await sleep(0.3);
    expect(strategy.state).toEqual(_WakeState.IDLE);

    // Frames should now be blocked again.
    const result = await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(result).toEqual(ProcessFrameResult.STOP);

    await strategy.cleanup();
  });

  test("test_single_activation_requires_wake_phrase_after_timeout", async () => {
    // Single activation mode requires wake phrase again after keepalive timeout.
    const strategy = createStrategy({ singleActivation: true, timeout: 0.1 });
    await setupStrategy(strategy);

    // First turn: wake phrase -> INACTIVE -> timeout -> LISTENING.
    await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(strategy.state).toEqual(_WakeState.AWAKE);
    await sleep(0.3);
    expect(strategy.state).toEqual(_WakeState.IDLE);

    // Without wake phrase, frames are blocked.
    let result = await strategy.processFrame(
      new TranscriptionFrame({ text: "what is the weather", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);

    // Second turn: wake phrase again.
    result = await strategy.processFrame(
      new TranscriptionFrame({ text: "hey pipecat", userId: "user1", timestamp: "" }),
    );
    expect(result).toEqual(ProcessFrameResult.STOP);
    expect(strategy.state).toEqual(_WakeState.AWAKE);

    await strategy.cleanup();
  });
});
