// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_turn_stop_strategy.py

import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";

import { sleep, type Task } from "@pipedog/asyncio";

import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  type Frame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  STTMetadataFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  UserTurnInferenceCompletedFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { FrameProcessorSetup } from "../src/processors/frame_processor.ts";
import type { ProcessFrameResult } from "../src/turns/types.ts";
import type {
  TriggerUserTurnStoppedOptions,
  UserTurnStoppedParams,
} from "../src/turns/user_stop/base_user_turn_stop_strategy.ts";
import type { ExternalUserTurnStopStrategyOptions } from "../src/turns/user_stop/external_user_turn_stop_strategy.ts";
import {
  BaseUserTurnStopStrategy,
  ExternalUserTurnCompletionStopStrategy,
  ExternalUserTurnStopStrategy,
  SpeechTimeoutUserTurnStopStrategy,
} from "../src/turns/user_stop/index.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { logger } from "../src/utils/logger.ts";

const AGGREGATION_TIMEOUT = 0.1;
// Use 0 STT timeout for deterministic test timing
const STT_TIMEOUT = 0.0;

/**
 * Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`.
 */
function frameProcessorSetup(taskManager: BaseTaskManager): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    taskManager,
    pipelineWorker: null,
  });
}

describe("TestSpeechTimeoutUserTurnStopStrategy", () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  /** Create strategy and configure STT timeout via metadata frame. */
  async function createStrategy(
    userSpeechTimeout = AGGREGATION_TIMEOUT,
  ): Promise<SpeechTimeoutUserTurnStopStrategy> {
    const strategy = new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout });
    await strategy.setup(frameProcessorSetup(taskManager));
    // Set STT timeout via metadata frame (as would happen in real pipeline)
    await strategy.processFrame(
      new STTMetadataFrame({ serviceName: "test", ttfsP99Latency: STT_TIMEOUT }),
    );
    return strategy;
  }

  function captureShouldStart(strategy: BaseUserTurnStopStrategy): { value: boolean | null } {
    const shouldStart: { value: boolean | null } = { value: null };
    strategy.eventHandler("on_user_turn_stopped", async (_strategy, _params) => {
      shouldStart.value = true;
    });
    return shouldStart;
  }

  function captureStopCount(strategy: BaseUserTurnStopStrategy): { value: number } {
    const stopCount = { value: 0 };
    strategy.eventHandler("on_user_turn_stopped", async (_strategy, _params) => {
      stopCount.value += 1;
    });
    return stopCount;
  }

  test("test_ste", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // T
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // Transcription came in between user started/stopped. Now we wait for
    // timeout before triggering.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_site", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // T
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // Transcription came in between user started/stopped. Now we wait for
    // timeout before triggering.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_st1iest2e", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // T1
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // T2
    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // Now we wait for timeout before triggering.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_siet", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "How", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // T
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // Transcription comes after user stopped speaking, we need to wait for
    // at least the aggregation timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_sieit", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "How", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // T
    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // Transcription comes after user stopped speaking, we need to wait for
    // at least the aggregation timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_set", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // T
    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // Transcription comes after user stopped speaking, we need to wait for
    // at least the aggregation timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_seit", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "How", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // T
    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // Transcription comes after user stopped speaking, we need to wait for
    // at least the aggregation timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_st1et2", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // T1
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // Transcription came between user start/stopped speaking, wait for timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
    shouldStart.value = null;

    // Arm for the next turn (the controller notifies stop strategies at turn start)
    await strategy.handleUserTurnStarted();

    // S - new turn starts
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // T2
    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // Transcription comes after user stopped speaking, we need to wait for
    // at least the aggregation timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_set1t2", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // T1
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // T2
    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // Transcription comes after user stopped speaking, we need to wait for
    // at least the aggregation timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_siet1it2", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // T1
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "How", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // T2
    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // Transcription comes after user stopped speaking, we need to wait for
    // at least the aggregation timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  /** Transcription without VAD - uses fallback timeout. */
  test("test_t", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // T
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // Transcription without VAD triggers fallback timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  /** Interim + Transcription without VAD - uses fallback timeout. */
  test("test_it", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );

    // T
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart.value).toBeNull();

    // Transcription without VAD triggers fallback timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  test("test_sie_delay_it", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // Delay - timeout expires but no transcript yet
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    // Still no trigger because no transcript received
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "How", userId: "cat", timestamp: "" }),
    );

    // T (finalized) - triggers immediately since timeout already elapsed
    await strategy.processFrame(
      new TranscriptionFrame({
        text: "How are you?",
        userId: "cat",
        timestamp: "",
        finalized: true,
      }),
    );

    // Finalized transcript received after timeout, triggers immediately
    expect(shouldStart.value).toBe(true);
  });

  /** Non-finalized transcript arriving after timeout triggers immediately. */
  test("test_sie_delay_t", async () => {
    const strategy = await createStrategy();
    const shouldStart = captureShouldStart(strategy);

    // S
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // I
    await strategy.processFrame(
      new InterimTranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );

    // E
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart.value).toBeNull();

    // Delay - timeout expires but no transcript yet
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    // Still no trigger because no finalized transcript received
    expect(shouldStart.value).toBeNull();

    // T (non-finalized) - triggers immediately since timeout already elapsed
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );

    // Non-finalized transcript received after timeout, triggers immediately
    expect(shouldStart.value).toBe(true);
  });

  /**
   * Finalized transcript cancels the stt_timeout safety net.
   *
   * user_speech_timeout still runs to completion as a policy floor,
   * but stt_timeout is skipped once STT says it's done. Net effect:
   * the turn stops at user_speech_timeout, not stt_timeout.
   */
  test("test_finalized_short_circuits_stt_wait", async () => {
    const sttTimeout = AGGREGATION_TIMEOUT * 4;
    const strategy = new SpeechTimeoutUserTurnStopStrategy({
      userSpeechTimeout: AGGREGATION_TIMEOUT,
    });
    await strategy.setup(frameProcessorSetup(taskManager));
    await strategy.processFrame(
      new STTMetadataFrame({ serviceName: "test", ttfsP99Latency: sttTimeout }),
    );

    const shouldStart = captureShouldStart(strategy);

    // S → E: starts user_speech_timeout (short) and stt_timeout (long).
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());

    // Finalized transcript arrives before user_speech_timeout elapses.
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "", finalized: true }),
    );
    // user_speech_timeout is still running, so no trigger yet.
    expect(shouldStart.value).toBeNull();

    // user_speech_timeout elapses — stt_timeout was short-circuited,
    // so the turn stops now rather than waiting for stt_timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  /**
   * Non-finalized transcript does not short-circuit stt_timeout.
   *
   * When STT never signals finalization, the stt_timeout safety net
   * must run its full course — the turn should not stop until the
   * longer of the two timers has elapsed.
   */
  test("test_non_finalized_waits_full_stt_timeout", async () => {
    const sttTimeout = AGGREGATION_TIMEOUT * 4;
    const strategy = new SpeechTimeoutUserTurnStopStrategy({
      userSpeechTimeout: AGGREGATION_TIMEOUT,
    });
    await strategy.setup(frameProcessorSetup(taskManager));
    await strategy.processFrame(
      new STTMetadataFrame({ serviceName: "test", ttfsP99Latency: sttTimeout }),
    );

    const shouldStart = captureShouldStart(strategy);

    // S → E: both timers start.
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());

    // Non-finalized transcript during the wait.
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );

    // user_speech_timeout elapses but stt_timeout has not — no trigger.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBeNull();

    // Wait for the remainder of stt_timeout.
    await sleep(sttTimeout - AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  /**
   * Fallback path (no VAD) ignores stt_timeout and uses only user_speech_timeout.
   *
   * stt_timeout is defined as "p99 after VAD stop" — without a VAD
   * reference point it has no meaning. The fallback measures
   * inactivity since the last transcript, which is user_speech_timeout.
   */
  test("test_fallback_uses_only_user_speech_timeout", async () => {
    const sttTimeout = AGGREGATION_TIMEOUT * 4;
    const strategy = new SpeechTimeoutUserTurnStopStrategy({
      userSpeechTimeout: AGGREGATION_TIMEOUT,
    });
    await strategy.setup(frameProcessorSetup(taskManager));
    await strategy.processFrame(
      new STTMetadataFrame({ serviceName: "test", ttfsP99Latency: sttTimeout }),
    );

    const shouldStart = captureShouldStart(strategy);

    // Transcript arrives without any VAD frame — fallback path.
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );

    // The fallback timer is user_speech_timeout, not stt_timeout.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(shouldStart.value).toBe(true);
  });

  /**
   * Test that a mid-utterance turn start does not falsely stop the turn.
   *
   * `UserTurnController` calls `handleUserTurnStarted` on all stop
   * strategies when a turn starts (see `_triggerUserTurnStart`), which can
   * happen right after a `VADUserStartedSpeakingFrame` with no matching stop
   * yet — the user is still speaking. The callback must preserve that live
   * VAD state so a finalized transcript for a mid-utterance segment (as
   * streaming STT services emit) is not treated as the no-VAD fallback and
   * stopped by `user_speech_timeout` while the user never stopped talking.
   */
  test("test_turn_start_mid_utterance_falsely_stops_turn", async () => {
    const strategy = await createStrategy();
    const stopCount = captureStopCount(strategy);

    // User starts speaking; VAD reports start.
    await strategy.processFrame(new VADUserStartedSpeakingFrame());

    // Turn start, as UserTurnController performs when the turn begins.
    // No VADUserStoppedSpeakingFrame has been received — the user is
    // still speaking.
    await strategy.handleUserTurnStarted();

    // Streaming STT finalizes a mid-utterance segment while the user is
    // still talking (no VAD stop event was ever emitted).
    await strategy.processFrame(
      new TranscriptionFrame({
        text: "So I was thinking",
        userId: "cat",
        timestamp: "",
        finalized: true,
      }),
    );

    // The user never stopped speaking, so the turn must not stop just
    // because user_speech_timeout elapses.
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(stopCount.value).toEqual(0);
  });

  /**
   * Turn callbacks clear stale text and cancel timeouts, preventing premature stop.
   *
   * Reproduces the bug from issue #4053: after turn 1 completes and the
   * stop callback runs, a late transcription sets _text. Arming at turn 2
   * start (handleUserTurnStarted) should clear the stale _text so no
   * premature stop occurs on VAD stop.
   */
  test("test_turn_callbacks_clear_stale_text_no_premature_stop", async () => {
    const strategy = await createStrategy();
    const stopCount = captureStopCount(strategy);

    // === Turn 1: S-T-E ===
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(stopCount.value).toEqual(1);

    // Turn 1 ends (as the controller notifies stop strategies at turn stop)
    await strategy.handleUserTurnStopped();

    // === Late transcription arrives between turns ===
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "cat", timestamp: "" }),
    );

    // Turn 2 arms (the controller notifies stop strategies at turn start)
    await strategy.handleUserTurnStarted();

    // === Turn 2: S-T-E (transcription arrives during turn) ===
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    await strategy.processFrame(new VADUserStoppedSpeakingFrame());

    // Wait for timeout — should get turn 2 stop with the real transcription
    await sleep(AGGREGATION_TIMEOUT + 0.1);
    expect(stopCount.value).toEqual(2);
  });
});

/** Tests for stop_secs misconfiguration warnings. */
describe("TestSpeechTimeoutStopSecsWarnings", () => {
  let taskManager: TaskManager;
  // Upstream patches the module's `logger`; the TS module shares the
  // singleton logger, so spying on its `warning` method is equivalent.
  let mockWarning: Mock<(message: string) => void>;

  beforeEach(() => {
    taskManager = new TaskManager();
    mockWarning = spyOn(logger, "warning").mockImplementation(() => {});
  });

  afterEach(() => {
    mockWarning.mockRestore();
  });

  async function createStrategy(sttTimeout = 0.35): Promise<SpeechTimeoutUserTurnStopStrategy> {
    const strategy = new SpeechTimeoutUserTurnStopStrategy({
      userSpeechTimeout: AGGREGATION_TIMEOUT,
    });
    await strategy.setup(frameProcessorSetup(taskManager));
    await strategy.processFrame(
      new STTMetadataFrame({ serviceName: "test", ttfsP99Latency: sttTimeout }),
    );
    return strategy;
  }

  test("test_warns_on_non_default_stop_secs", async () => {
    // Use high stt_timeout so only Warning A fires (stop_secs < stt_timeout)
    const strategy = await createStrategy(1.0);

    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.5 }));

    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockWarning.mock.calls[0]?.[0]).toContain("differs from the recommended default");
  });

  test("test_warns_on_stop_secs_gte_stt_timeout", async () => {
    const strategy = await createStrategy(0.35);

    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.5 }));

    // Both warnings fire: non-default stop_secs AND stop_secs >= stt_timeout
    expect(mockWarning.mock.calls.length).toEqual(2);
    expect(mockWarning.mock.calls[1]?.[0]).toContain("collapsed to 0s");
  });

  test("test_warns_only_once", async () => {
    // Use high stt_timeout so only Warning A fires
    const strategy = await createStrategy(1.0);

    // First VAD stop — triggers warning
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.5 }));
    expect(mockWarning.mock.calls.length).toEqual(1);

    // Second VAD stop — no duplicate warning
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.5 }));
    expect(mockWarning.mock.calls.length).toEqual(1);
  });

  test("test_warning_resets_on_new_stt_metadata", async () => {
    // Use high stt_timeout so only Warning A fires
    const strategy = await createStrategy(1.0);

    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.5 }));
    expect(mockWarning.mock.calls.length).toEqual(1);

    // New STTMetadataFrame resets the warned flag
    await strategy.processFrame(new STTMetadataFrame({ serviceName: "test", ttfsP99Latency: 1.0 }));

    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.5 }));
    expect(mockWarning.mock.calls.length).toEqual(2);
  });

  test("test_no_warning_on_default_stop_secs", async () => {
    const strategy = await createStrategy();

    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.2 }));

    expect(mockWarning).not.toHaveBeenCalled();
  });
});

describe("TestExternalUserTurnCompletionStopStrategy", () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  async function createStrategy(): Promise<ExternalUserTurnCompletionStopStrategy> {
    const strategy = new ExternalUserTurnCompletionStopStrategy();
    await strategy.setup(frameProcessorSetup(taskManager));
    return strategy;
  }

  /**
   * The strategy fires on_user_turn_stopped on UserTurnInferenceCompletedFrame.
   *
   * The stale-completion-while-speaking gate lives in the controller (which
   * holds the authoritative user-speaking state), not in this strategy; see
   * test_user_turn_controller.py.
   */
  test("test_finalizes_on_completion", async () => {
    const strategy = await createStrategy();

    let finalized = false;

    strategy.eventHandler("on_user_turn_stopped", async (_strategy, _params) => {
      finalized = true;
    });

    await strategy.processFrame(new UserTurnInferenceCompletedFrame());
    expect(finalized).toBe(true);
  });
});

describe("TestExternalUserTurnStopStrategy", () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  /** Drive one turn through the strategy and return the stop params. */
  async function runTurn(
    strategy: ExternalUserTurnStopStrategy,
    { started, stopped }: { started: Frame; stopped: Frame },
  ): Promise<UserTurnStoppedParams | null> {
    let params: UserTurnStoppedParams | null = null;

    strategy.eventHandler(
      "on_user_turn_stopped",
      async (_strategy, stopParams: UserTurnStoppedParams) => {
        params = stopParams;
      },
    );

    await strategy.processFrame(started);
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    await strategy.processFrame(stopped);
    return params;
  }

  test("test_external_strategy", async () => {
    const strategy = new ExternalUserTurnStopStrategy();

    let shouldStart: boolean | null = null;

    strategy.eventHandler("on_user_turn_stopped", async (_strategy, _params) => {
      shouldStart = true;
    });

    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart).toBeFalsy();

    await strategy.processFrame(new UserStartedSpeakingFrame());
    expect(shouldStart).toBeFalsy();

    await strategy.processFrame(new UserStoppedSpeakingFrame());
    expect(shouldStart).toBeFalsy();

    await strategy.processFrame(new UserStartedSpeakingFrame());
    expect(shouldStart).toBeFalsy();

    await strategy.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart).toBeFalsy();

    await strategy.processFrame(new UserStoppedSpeakingFrame());
    expect(shouldStart).toBe(true);
  });

  test("test_proposal_finalizes_with_emission_enabled", async () => {
    const strategy = new ExternalUserTurnStopStrategy();
    await strategy.setup(frameProcessorSetup(taskManager));
    const params = await runTurn(strategy, {
      started: new ProposedUserStartedSpeakingFrame(),
      stopped: new ProposedUserStoppedSpeakingFrame(),
    });
    expect(params).not.toBeNull();
    expect(params!.enableUserSpeakingFrames).toBe(true);
    await strategy.cleanup();
  });

  test("test_real_turn_frame_finalizes_with_emission_suppressed", async () => {
    const strategy = new ExternalUserTurnStopStrategy();
    await strategy.setup(frameProcessorSetup(taskManager));
    const params = await runTurn(strategy, {
      started: new UserStartedSpeakingFrame(),
      stopped: new UserStoppedSpeakingFrame(),
    });
    expect(params).not.toBeNull();
    expect(params!.enableUserSpeakingFrames).toBe(false);
    await strategy.cleanup();
  });

  /**
   * The idle timer must stay quiet between turns.
   *
   * With wait_for_transcript off (how realtime mode configures this
   * strategy) the timer path would otherwise fire on every tick forever.
   */
  test("test_no_timer_driven_finalization_while_no_turn_is_open", async () => {
    const strategy = new ExternalUserTurnStopStrategy({ timeout: 0.05, waitForTranscript: false });
    await strategy.setup(frameProcessorSetup(taskManager));

    let fired = 0;

    strategy.eventHandler("on_user_turn_stopped", async (_strategy, _params) => {
      fired += 1;
    });

    // Never started a turn: several timer ticks should pass in silence.
    await sleep(0.3);
    expect(fired).toEqual(0);

    // Once a turn opens, the timer finalizes it as before.
    await strategy.handleUserTurnStarted();
    await strategy.processFrame(new ProposedUserStoppedSpeakingFrame());
    expect(fired).toEqual(1);

    // And falls silent again after the turn ends.
    await strategy.handleUserTurnStopped();
    await sleep(0.3);
    expect(fired).toEqual(1);

    await strategy.cleanup();
  });

  /**
   * Finalization from the transcript timeout carries the right flags.
   *
   * A transcript that arrives after the stop signal closes the turn from
   * the internal timeout, long after the signal that determined whether
   * emission is suppressed. This ordering happens with services whose
   * stop signal and transcript come from independent events; a service
   * that pushes the transcript before proposing the stop takes the
   * immediate path instead.
   */
  test("test_deferred_finalization_keeps_the_signals_emission_flags", async () => {
    const strategy = new ExternalUserTurnStopStrategy({ timeout: 0.05 });
    await strategy.setup(frameProcessorSetup(taskManager));

    let params: UserTurnStoppedParams | null = null;

    strategy.eventHandler(
      "on_user_turn_stopped",
      async (_strategy, stopParams: UserTurnStoppedParams) => {
        params = stopParams;
      },
    );

    // The controller opens the turn on every stop strategy before any
    // signals arrive; the timer path only runs while a turn is open.
    await strategy.handleUserTurnStarted();

    // Stop signal first, transcript after: the stop resolves from the
    // timeout in the strategy's task handler.
    await strategy.processFrame(new UserStartedSpeakingFrame());
    await strategy.processFrame(new UserStoppedSpeakingFrame());
    expect(params).toBeNull();

    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    await sleep(0.15);
    expect(params).not.toBeNull();
    expect(params!.enableUserSpeakingFrames).toBe(false);
    await strategy.cleanup();
  });

  /**
   * A subclass can shift turn-stop timing — the motivator for proposals.
   *
   * Mirrors `GracePeriodUserTurnStopStrategy` from
   * `examples/turn-management/turn-management-custom-external-turn-strategy.py`.
   */
  test("test_subclass_can_delay_finalization", async () => {
    class DelayedStopStrategy extends ExternalUserTurnStopStrategy {
      pending: Task<unknown> | null;

      constructor(options: ExternalUserTurnStopStrategyOptions = {}) {
        super(options);
        this.pending = null;
      }

      override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
        if (frame instanceof ProposedUserStartedSpeakingFrame && this.pending) {
          const task = this.pending;
          this.pending = null;
          await this.cancelTask(task);
        }
        return await super.processFrame(frame);
      }

      override async triggerUserTurnStopped(
        options: TriggerUserTurnStoppedOptions = {},
      ): Promise<void> {
        if (this.pending) {
          return;
        }
        this.pending = this.createTask(() =>
          this._finalizeLater(options.enableUserSpeakingFrames ?? null),
        );
      }

      async _finalizeLater(enableUserSpeakingFrames: boolean | null): Promise<void> {
        await sleep(0.2);
        this.pending = null;
        await super.triggerUserTurnStopped({ enableUserSpeakingFrames });
      }
    }

    const strategy = new DelayedStopStrategy();
    await strategy.setup(frameProcessorSetup(taskManager));

    let stopParams: UserTurnStoppedParams | null = null;

    strategy.eventHandler(
      "on_user_turn_stopped",
      async (_strategy, params: UserTurnStoppedParams) => {
        stopParams = params;
      },
    );

    await strategy.processFrame(new ProposedUserStartedSpeakingFrame());
    await strategy.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    await strategy.processFrame(new ProposedUserStoppedSpeakingFrame());
    // The base strategy would have finalized by now; this one holds the turn.
    expect(stopParams).toBeNull();

    // Resuming within the grace period keeps the turn open.
    await strategy.processFrame(new ProposedUserStartedSpeakingFrame());
    await sleep(0.3);
    expect(stopParams).toBeNull();

    // Falling silent again lets the delayed finalization through, still
    // carrying the emission setting the decide path handed the override.
    await strategy.processFrame(new ProposedUserStoppedSpeakingFrame());
    await sleep(0.3);
    expect(stopParams).not.toBeNull();
    expect(stopParams!.enableUserSpeakingFrames).toBe(true);

    await strategy.cleanup();
  });
});

describe("TestBaseUserTurnStopStrategyDeprecations", () => {
  async function captureParams(
    strategy: BaseUserTurnStopStrategy,
  ): Promise<UserTurnStoppedParams[]> {
    const captured: UserTurnStoppedParams[] = [];

    strategy.eventHandler(
      "on_user_turn_stopped",
      async (_strategy, params: UserTurnStoppedParams) => {
        captured.push(params);
      },
    );

    return captured;
  }

  // Deprecated upstream API: the `enable_user_speaking_frames` constructor
  // argument of BaseUserTurnStopStrategy is not ported.
  test.skip("test_enable_user_speaking_frames_warns", () => {});

  // Deprecated upstream API: the `enable_user_speaking_frames` constructor
  // argument of BaseUserTurnStopStrategy is not ported.
  test.skip("test_enable_user_speaking_frames_applies", () => {});

  // The deprecated argument is not ported, so there is no warning to check
  // for; the non-deprecated behavior (emission enabled by default) is.
  test("test_omitting_enable_user_speaking_frames_is_silent", async () => {
    const strategy = new BaseUserTurnStopStrategy();
    const captured = await captureParams(strategy);

    await strategy.triggerUserTurnStopped();
    expect(captured[0]!.enableUserSpeakingFrames).toBe(true);
  });
});
