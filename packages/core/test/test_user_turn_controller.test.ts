// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_turn_controller.py

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createTask, Event, monotonic, sleep, waitFor } from "@pipecat-ts/asyncio";

import { type BaseTurnAnalyzer, EndOfTurnState } from "../src/audio/turn/base_turn_analyzer.ts";
import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  BotStartedSpeakingFrame,
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
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import {
  BaseUserTurnStartStrategy,
  ExternalUserTurnStartStrategy,
  type UserTurnStartedParams,
  VADUserTurnStartStrategy,
} from "../src/turns/user_start/index.ts";
import { MinWordsUserTurnStartStrategy } from "../src/turns/user_start/min_words_user_turn_start_strategy.ts";
import {
  BaseUserTurnStopStrategy,
  deferred,
  ExternalUserTurnCompletionStopStrategy,
  ExternalUserTurnStopStrategy,
  SpeechTimeoutUserTurnStopStrategy,
  TurnAnalyzerUserTurnStopStrategy,
  type UserTurnStoppedParams,
} from "../src/turns/user_stop/index.ts";
import type { TurnAnalyzerUserTurnStopStrategyOptions } from "../src/turns/user_stop/turn_analyzer_user_turn_stop_strategy.ts";
import { UserTurnController } from "../src/turns/user_turn_controller.ts";
import {
  ExternalUserTurnStrategies,
  UserTurnStrategies,
} from "../src/turns/user_turn_strategies.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";
import type { BaseObject } from "../src/utils/base_object.ts";

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

/**
 * Stand-in for upstream's `MagicMock()` turn analyzer: every method the
 * strategy may touch is a mock, and `analyzeEndOfTurn` can be overridden.
 */
function mockTurnAnalyzer(
  overrides: Partial<Record<string, unknown>> = {},
): BaseTurnAnalyzer & { clear: ReturnType<typeof mock> } {
  return {
    clear: mock(() => {}),
    cleanup: mock(async () => {}),
    setSampleRate: mock(() => {}),
    appendAudio: mock(() => EndOfTurnState.INCOMPLETE),
    analyzeEndOfTurn: mock(async () => [EndOfTurnState.INCOMPLETE, null]),
    updateVadStartSecs: mock(() => {}),
    params: {},
    ...overrides,
  } as unknown as BaseTurnAnalyzer & { clear: ReturnType<typeof mock> };
}

const USER_TURN_STOP_TIMEOUT = 0.2;
const TRANSCRIPTION_TIMEOUT = 0.1;

describe("TestUserTurnController", () => {
  let taskManager: TaskManager;

  beforeEach(() => {
    taskManager = new TaskManager();
  });

  test("test_completion_dropped_while_user_speaking", async () => {
    // A completion arriving while the user speaks must not stop the turn.
    //
    // External completions (e.g. an LLM ●) resolve with latency, so the user
    // may have resumed speaking. The controller drops the finalization while
    // the user is speaking and finalizes once they fall silent.
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: [new VADUserTurnStartStrategy()],
        stop: [new ExternalUserTurnCompletionStopStrategy()],
      }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    let stopped = false;

    controller.eventHandler("on_user_turn_stopped", async () => {
      stopped = true;
    });

    // Start a turn; the user is now speaking.
    await controller.processFrame(new VADUserStartedSpeakingFrame());

    // A completion resolving while the user still speaks is stale: dropped.
    await controller.processFrame(new UserTurnInferenceCompletedFrame());
    expect(stopped).toBe(false);

    // Once the user stops, a fresh completion finalizes the turn.
    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    await controller.processFrame(new UserTurnInferenceCompletedFrame());
    expect(stopped).toBe(true);

    await controller.cleanup();
  });

  test("test_default_user_turn_strategies", async () => {
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT })],
      }),
    });

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    let shouldStart: boolean | null = null;
    let shouldStop: boolean | null = null;

    controller.eventHandler("on_user_turn_started", async () => {
      shouldStart = true;
    });

    controller.eventHandler("on_user_turn_stopped", async () => {
      shouldStop = true;
    });

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart).toBeTruthy();
    expect(shouldStop).toBeFalsy();

    await controller.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    expect(shouldStart).toBeTruthy();
    expect(shouldStop).toBeFalsy();

    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart).toBeTruthy();
    // Wait for user_speech_timeout to elapse
    await sleep(TRANSCRIPTION_TIMEOUT + 0.1);
    expect(shouldStop).toBeTruthy();
  });

  test("test_update_strategies_does_not_accumulate_event_handlers", async () => {
    // Regression: re-applying strategies (e.g. realtime mode re-installing the
    // same instances, or repeated metadata broadcasts) must not accumulate
    // duplicate controller event handlers on the strategy instances —
    // _cleanupStrategies removes what _setupStrategies added.
    const start = new VADUserTurnStartStrategy();
    const stop = new SpeechTimeoutUserTurnStopStrategy({
      userSpeechTimeout: TRANSCRIPTION_TIMEOUT,
    });
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({ start: [start], stop: [stop] }),
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    // Re-apply the same strategy instances several times.
    for (let i = 0; i < 3; i++) {
      await controller.updateStrategies(new UserTurnStrategies({ start: [start], stop: [stop] }));
    }

    for (const strategy of [start, stop] as BaseObject[]) {
      const handlers = (
        strategy as unknown as { _eventHandlers: Map<string, { handlers: unknown[] }> }
      )._eventHandlers;
      for (const [name, handler] of handlers) {
        expect(
          handler.handlers.length,
          `${name} double-registered on ${strategy}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  test("test_inference_triggered_fires_alongside_stopped", async () => {
    // Default strategies fire both inference-triggered and stopped, in order.
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT })],
      }),
    });

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    const events: string[] = [];

    controller.eventHandler("on_user_turn_inference_triggered", async () => {
      events.push("inference_triggered");
    });

    controller.eventHandler("on_user_turn_stopped", async () => {
      events.push("stopped");
    });

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await controller.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    await sleep(TRANSCRIPTION_TIMEOUT + 0.1);

    expect(events).toEqual(["inference_triggered", "stopped"]);
  });

  test("test_deferred_wrapper_skips_stopped", async () => {
    // A deferred() wrapper drops the inner strategy's on_user_turn_stopped event.
    const wrapped = deferred(
      new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT }),
    );
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({ stop: [wrapped] }),
    });

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    const events: string[] = [];

    controller.eventHandler("on_user_turn_inference_triggered", async () => {
      events.push("inference_triggered");
    });

    controller.eventHandler("on_user_turn_stopped", async () => {
      events.push("stopped");
    });

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await controller.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    await sleep(TRANSCRIPTION_TIMEOUT + 0.1);

    // The inner strategy fires inference-triggered (forwarded by the
    // wrapper). Finalization is suppressed, but the controller's
    // stop watchdog eventually fires `stopped`.
    expect(events[0]).toEqual("inference_triggered");
  });

  test("test_user_turn_start_reset", async () => {
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: [new MinWordsUserTurnStartStrategy({ minWords: 3 })],
      }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    let shouldStart = 0;

    controller.eventHandler("on_user_turn_started", async () => {
      shouldStart += 1;
    });

    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.processFrame(
      new TranscriptionFrame({ text: "One", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart).toEqual(0);

    await controller.processFrame(
      new TranscriptionFrame({ text: "One two three!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart).toEqual(1);

    // Trigger user stop turn so we can trigger user start turn again.
    await sleep(USER_TURN_STOP_TIMEOUT + 0.1);

    await controller.processFrame(new BotStartedSpeakingFrame());
    await controller.processFrame(
      new TranscriptionFrame({ text: "Hi!", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart).toEqual(1);

    await controller.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "cat", timestamp: "" }),
    );
    expect(shouldStart).toEqual(2);
  });

  test("test_user_turn_stop_timeout_no_transcription", async () => {
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies(),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    let shouldStart: boolean | null = null;
    let shouldStop: boolean | null = null;
    let timeout: boolean | null = null;

    controller.eventHandler("on_user_turn_started", async () => {
      shouldStart = true;
    });

    controller.eventHandler("on_user_turn_stopped", async () => {
      shouldStop = true;
    });

    controller.eventHandler("on_user_turn_stop_timeout", async () => {
      timeout = true;
    });

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    expect(shouldStart).toBeTruthy();
    expect(shouldStop).toBeFalsy();
    expect(timeout).toBeFalsy();

    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    expect(shouldStart).toBeTruthy();
    expect(shouldStop).toBeFalsy();

    await sleep(USER_TURN_STOP_TIMEOUT + 0.1);
    expect(shouldStart).toBeTruthy();
    expect(shouldStop).toBeTruthy();
    expect(timeout).toBeTruthy();
  });

  test("test_external_user_turn_strategies_no_timeout_while_speaking", async () => {
    // Test that timeout does not trigger when user is still speaking with external strategies.
    const controller = new UserTurnController({
      userTurnStrategies: new ExternalUserTurnStrategies(),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    let shouldStart: boolean | null = null;
    let shouldStop: boolean | null = null;
    let timeout: boolean | null = null;

    controller.eventHandler("on_user_turn_started", async () => {
      shouldStart = true;
    });

    controller.eventHandler("on_user_turn_stopped", async () => {
      shouldStop = true;
    });

    controller.eventHandler("on_user_turn_stop_timeout", async () => {
      timeout = true;
    });

    // Simulate external service (like Deepgram Flux) broadcasting UserStartedSpeakingFrame
    await controller.processFrame(new UserStartedSpeakingFrame());
    expect(shouldStart).toBeTruthy();
    expect(shouldStop).toBeFalsy();
    expect(timeout).toBeFalsy();

    // User is still speaking, timeout should not trigger
    await sleep(USER_TURN_STOP_TIMEOUT + 0.1);
    expect(shouldStart).toBeTruthy();
    expect(shouldStop).toBeFalsy();
    expect(timeout).toBeFalsy();

    // Now external service broadcasts UserStoppedSpeakingFrame
    await controller.processFrame(new UserStoppedSpeakingFrame());

    // But no transcription, so timeout should trigger
    await sleep(USER_TURN_STOP_TIMEOUT + 0.1);

    expect(shouldStart).toBeTruthy();
    expect(shouldStop).toBeTruthy();
    expect(timeout).toBeTruthy();
  });

  test("test_proposed_frames_drive_the_turn_and_emit", async () => {
    // A proposal leaves the decision to the strategy, which emits.
    const controller = new UserTurnController({
      userTurnStrategies: new ExternalUserTurnStrategies(),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    let startedParams: UserTurnStartedParams | null = null;
    let stoppedParams: UserTurnStoppedParams | null = null;

    controller.eventHandler(
      "on_user_turn_started",
      async (_c: unknown, _s: unknown, params: UserTurnStartedParams) => {
        startedParams = params;
      },
    );

    controller.eventHandler(
      "on_user_turn_stopped",
      async (_c: unknown, _s: unknown, params: UserTurnStoppedParams) => {
        stoppedParams = params;
      },
    );

    await controller.processFrame(new ProposedUserStartedSpeakingFrame());
    expect(startedParams!.enableUserSpeakingFrames).toBeTruthy();
    expect(startedParams!.enableInterruptions).toBeTruthy();

    await controller.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    await controller.processFrame(new ProposedUserStoppedSpeakingFrame());
    expect(stoppedParams!.enableUserSpeakingFrames).toBeTruthy();

    await controller.cleanup();
  });

  test("test_real_turn_frames_drive_the_turn_but_suppress_emission", async () => {
    // The emitter already announced the turn, so the strategy emits nothing.
    const controller = new UserTurnController({
      userTurnStrategies: new ExternalUserTurnStrategies(),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    let startedParams: UserTurnStartedParams | null = null;
    let stoppedParams: UserTurnStoppedParams | null = null;

    controller.eventHandler(
      "on_user_turn_started",
      async (_c: unknown, _s: unknown, params: UserTurnStartedParams) => {
        startedParams = params;
      },
    );

    controller.eventHandler(
      "on_user_turn_stopped",
      async (_c: unknown, _s: unknown, params: UserTurnStoppedParams) => {
        stoppedParams = params;
      },
    );

    await controller.processFrame(new UserStartedSpeakingFrame());
    expect(startedParams!.enableUserSpeakingFrames).toBeFalsy();
    expect(startedParams!.enableInterruptions).toBeFalsy();

    await controller.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    await controller.processFrame(new UserStoppedSpeakingFrame());
    expect(stoppedParams!.enableUserSpeakingFrames).toBeFalsy();

    await controller.cleanup();
  });

  test("test_proposal_arriving_mid_speech_does_not_stop_the_turn", async () => {
    // The finalization guard still applies when proposals drive the turn.
    const controller = new UserTurnController({
      userTurnStrategies: new ExternalUserTurnStrategies(),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    let stopped = false;

    controller.eventHandler("on_user_turn_stopped", async () => {
      stopped = true;
    });

    // The controller tracks _userSpeaking from the proposals, so a
    // completion resolving mid-speech is still dropped as stale.
    await controller.processFrame(new ProposedUserStartedSpeakingFrame());
    await controller.processFrame(new UserTurnInferenceCompletedFrame());
    expect(stopped).toBe(false);

    await controller.cleanup();
  });

  test("test_proposals_are_resolved_only_by_resolving_strategies", async () => {
    // A controller whose strategies can't resolve a proposal reports so.
    const external = new UserTurnController({
      userTurnStrategies: new ExternalUserTurnStrategies(),
    });
    expect(external.resolvesProposedTurnStartFrames).toBe(true);
    expect(external.resolvesProposedTurnStopFrames).toBe(true);

    const defaultController = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: [new VADUserTurnStartStrategy()],
        stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT })],
      }),
    });
    expect(defaultController.resolvesProposedTurnStartFrames).toBe(false);
    expect(defaultController.resolvesProposedTurnStopFrames).toBe(false);
  });

  test("test_each_side_reports_its_own_proposal_resolution", async () => {
    // Resolving turn starts says nothing about turn stops, and vice versa.
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: [new ExternalUserTurnStartStrategy()],
        stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT })],
      }),
    });
    expect(controller.resolvesProposedTurnStartFrames).toBe(true);
    expect(controller.resolvesProposedTurnStopFrames).toBe(false);
  });

  test("test_custom_strategies_can_resolve_proposals", async () => {
    // Resolution follows what a strategy declares, not what class it is.

    class CustomStartStrategy extends BaseUserTurnStartStrategy {
      override get resolvesProposedTurnStartFrames(): boolean {
        return true;
      }
    }

    class CustomStopStrategy extends BaseUserTurnStopStrategy {
      override get resolvesProposedTurnStopFrames(): boolean {
        return true;
      }
    }

    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: [new CustomStartStrategy()],
        stop: [new CustomStopStrategy()],
      }),
    });
    expect(controller.resolvesProposedTurnStartFrames).toBe(true);
    expect(controller.resolvesProposedTurnStopFrames).toBe(true);
  });

  test("test_deferring_a_strategy_keeps_its_proposal_resolution", async () => {
    // Deferred finalization changes when the turn ends, not who decides it.
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        stop: [deferred(new ExternalUserTurnStopStrategy())],
      }),
    });
    expect(controller.resolvesProposedTurnStopFrames).toBe(true);
  });

  test("test_late_transcription_between_turns_no_premature_stop", async () => {
    // Test that a late transcription arriving between turns does not cause a premature stop.
    //
    // Reproduces the bug from issue #4053: after turn 1 completes and reset()
    // clears state, a late TranscriptionFrame sets _text to stale content. On
    // the next turn, that stale _text gates a premature turn stop via timeout(0)
    // before the current turn's transcript arrives.
    //
    // Uses only VADUserTurnStartStrategy (no TranscriptionUserTurnStartStrategy)
    // so the late transcription doesn't trigger a spurious turn start.
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: [new VADUserTurnStartStrategy()],
        stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT })],
      }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });

    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    let startCount = 0;
    let stopCount = 0;

    controller.eventHandler("on_user_turn_started", async () => {
      startCount += 1;
    });

    controller.eventHandler("on_user_turn_stopped", async () => {
      stopCount += 1;
    });

    // === Turn 1: S-T-E ===
    await controller.processFrame(new VADUserStartedSpeakingFrame());
    expect(startCount).toEqual(1);

    await controller.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );

    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    await sleep(TRANSCRIPTION_TIMEOUT + 0.1);
    expect(stopCount).toEqual(1);

    // === Between turns: late transcription arrives ===
    // This sets _text on the stop strategy while _userTurn is false.
    await controller.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );

    // === Turn 2: S-T-E (transcription arrives during turn) ===
    // The fix resets stop strategies at turn start, clearing stale _text.
    await controller.processFrame(new VADUserStartedSpeakingFrame());
    expect(startCount).toEqual(2);

    await controller.processFrame(
      new TranscriptionFrame({ text: "How are you?", userId: "", timestamp: "now" }),
    );

    await controller.processFrame(new VADUserStoppedSpeakingFrame());

    // Wait for user_speech_timeout to elapse — should get turn 2 stop
    await sleep(TRANSCRIPTION_TIMEOUT + 0.1);
    expect(stopCount).toEqual(2);
  });

  test("test_turn_start_notifies_start_and_stop_strategies", async () => {
    // Turn start calls handleUserTurnStarted on both start and stop strategies.
    const started: string[] = [];

    class SpyStart extends VADUserTurnStartStrategy {
      override async handleUserTurnStarted(): Promise<void> {
        started.push("start");
      }
    }

    class SpyStop extends SpeechTimeoutUserTurnStopStrategy {
      override async handleUserTurnStarted(): Promise<void> {
        await super.handleUserTurnStarted();
        started.push("stop");
      }
    }

    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: [new SpyStart()],
        stop: [new SpyStop({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT })],
      }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    expect(started).toEqual([]);
    await controller.processFrame(new VADUserStartedSpeakingFrame());
    expect(started).toEqual(["start", "stop"]);

    await controller.cleanup();
  });

  test("test_handle_user_turn_stopped_called_on_strategy_stop", async () => {
    // handleUserTurnStopped() runs on a stop strategy when it ends the turn, never at start.
    let finalized = 0;

    class SpyStopStrategy extends SpeechTimeoutUserTurnStopStrategy {
      override async handleUserTurnStopped(): Promise<void> {
        await super.handleUserTurnStopped();
        finalized += 1;
      }
    }

    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: [new VADUserTurnStartStrategy()],
        stop: [new SpyStopStrategy({ userSpeechTimeout: TRANSCRIPTION_TIMEOUT })],
      }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    expect(finalized).toEqual(0);

    await controller.processFrame(
      new TranscriptionFrame({ text: "Hello!", userId: "", timestamp: "now" }),
    );
    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    await sleep(TRANSCRIPTION_TIMEOUT + 0.1);
    expect(finalized).toEqual(1);

    await controller.cleanup();
  });

  test("test_handle_user_turn_stopped_called_on_watchdog_stop", async () => {
    // handleUserTurnStopped() also runs when the stop watchdog ends the turn.
    let finalized = 0;

    class SpyNeverStopStrategy extends ExternalUserTurnCompletionStopStrategy {
      override async handleUserTurnStopped(): Promise<void> {
        await super.handleUserTurnStopped();
        finalized += 1;
      }
    }

    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: [new VADUserTurnStartStrategy()],
        stop: [new SpyNeverStopStrategy()],
      }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    expect(finalized).toEqual(0);

    // No completion ever arrives; the watchdog finalizes the turn.
    await sleep(USER_TURN_STOP_TIMEOUT + 0.1);
    expect(finalized).toEqual(1);

    await controller.cleanup();
  });

  // The deprecated `reset()` hook (and its DeprecationWarning bridge) is not
  // ported, so the tests that only exercise it are skipped.
  test.skip("test_start_strategy_not_reset_on_turn_stop", () => {
    // Deprecated: exercises the deprecated reset() hook bridge (not ported).
  });

  test.skip("test_stop_strategy_reset_bridged_on_both_callbacks", () => {
    // Deprecated: exercises the deprecated reset() hook bridge (not ported).
  });

  test.skip("test_overriding_reset_warns_at_class_definition", () => {
    // Deprecated: exercises the reset() DeprecationWarning (not ported).
  });

  test.skip("test_reset_warning_shows_under_default_filters_at_the_subclass", () => {
    // Deprecated: exercises the reset() DeprecationWarning (not ported).
  });

  test.skip("test_subclass_of_concrete_strategy_overriding_reset_warns_but_is_not_bridged", () => {
    // Deprecated: exercises the reset() DeprecationWarning (not ported).
  });

  test.skip("test_overriding_callbacks_does_not_warn_at_class_definition", () => {
    // Deprecated: checks the absence of the reset() DeprecationWarning at class
    // definition, which only exists with the deprecated hook (not ported).
  });

  test("test_migrated_strategy_does_not_warn_at_runtime", async () => {
    // A strategy overriding the callbacks never warns on the per-turn callbacks.
    // (No deprecation warnings exist in the port; the callbacks must run cleanly.)
    const strategy = new SpeechTimeoutUserTurnStopStrategy({
      userSpeechTimeout: TRANSCRIPTION_TIMEOUT,
    });
    await strategy.setup(frameProcessorSetup(taskManager));
    await strategy.handleUserTurnStarted();
    await strategy.handleUserTurnStopped();
    await strategy.cleanup();
  });

  test("test_turn_analyzer_cleared_on_stop_but_not_start", async () => {
    // The analyzer is cleared when the turn ends, but not when it starts.
    //
    // Clearing on start would drop the continuously-fed pre-speech buffer;
    // that's the whole reason the clear can't live in the shared reset.
    const analyzer = mockTurnAnalyzer();
    const strategy = new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: analyzer });

    await strategy.handleUserTurnStarted();
    expect(analyzer.clear).not.toHaveBeenCalled();

    await strategy.handleUserTurnStopped();
    expect(analyzer.clear).toHaveBeenCalledTimes(1);
  });

  test("test_deferred_forwards_both_callbacks", async () => {
    // The deferred() wrapper forwards both callbacks to its inner strategy.
    const analyzer = mockTurnAnalyzer();
    const strategy = deferred(new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: analyzer }));

    await strategy.handleUserTurnStarted();
    expect(analyzer.clear).not.toHaveBeenCalled();

    await strategy.handleUserTurnStopped();
    expect(analyzer.clear).toHaveBeenCalledTimes(1);
  });

  /**
   * Build a TurnAnalyzerUserTurnStopStrategy whose analyzer takes real time.
   *
   * Returns [strategy, released] where `released` is an Event set when the
   * strategy fires on_user_turn_stopped.
   */
  function makeTurnAnalyzerStrategy(
    options: { inferenceSecs: number } & Omit<
      Partial<TurnAnalyzerUserTurnStopStrategyOptions>,
      "turnAnalyzer"
    >,
  ): [TurnAnalyzerUserTurnStopStrategy, Event] {
    const { inferenceSecs, ...kwargs } = options;

    const slowAnalyze = async () => {
      await sleep(inferenceSecs);
      return [EndOfTurnState.COMPLETE, null];
    };

    const analyzer = mockTurnAnalyzer({ analyzeEndOfTurn: slowAnalyze });

    const strategy = new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: analyzer, ...kwargs });

    const released = new Event();

    strategy.eventHandler("on_user_turn_stopped", async () => {
      released.set();
    });

    return [strategy, released];
  }

  test("test_stt_timeout_anchored_to_speech_end", async () => {
    // The STT safety-net timeout doesn't grow with analyzer inference time.
    //
    // The p99 budget is anchored at the end of the user's speech
    // (VAD stop timestamp minus stop_secs). Time the analyzer spends in
    // analyzeEndOfTurn() must come out of that budget, not extend it.
    const inferenceSecs = 0.3;
    const stopSecs = 0.2;
    const sttP99 = 0.6; // deadline: 0.4s after the VAD stop frame is created

    const [strategy, released] = makeTurnAnalyzerStrategy({ inferenceSecs });
    await strategy.setup(frameProcessorSetup(taskManager));
    await strategy.processFrame(
      new STTMetadataFrame({ serviceName: "stt", ttfsP99Latency: sttP99 }),
    );
    await strategy.processFrame(new VADUserStartedSpeakingFrame({ startSecs: stopSecs }));

    const start = monotonic();
    const vadStop = new VADUserStoppedSpeakingFrame({ stopSecs });
    const vadTask = createTask(() => strategy.processFrame(vadStop));
    // A non-finalized transcript arrives well within the budget.
    await strategy.processFrame(
      new TranscriptionFrame({ userId: "", text: "hello", timestamp: "now", finalized: false }),
    );
    await vadTask;

    await waitFor(() => released.wait(), 2.0);
    const elapsed = monotonic() - start;

    // Unanchored, release would come at inference + (p99 - stop_secs) = 0.7s.
    // Anchored, it comes at p99 - stop_secs = 0.4s after the VAD stop frame.
    expect(elapsed).toBeLessThan(0.55);
    expect(elapsed).toBeGreaterThanOrEqual(inferenceSecs);

    await strategy.cleanup();
  });

  test("test_finalized_transcript_during_inference_releases_immediately", async () => {
    // A transcript that finalizes mid-inference releases the turn right after.
    //
    // Transcripts are data frames and VAD stop is a system frame, so they are
    // processed on different tasks and can interleave with the
    // analyzeEndOfTurn() await. Once the analyzer's verdict lands, the
    // already-finalized transcript must release the turn immediately instead
    // of waiting out the safety-net timer.
    const inferenceSecs = 0.3;
    const sttP99 = 5.0; // timer far out, so an immediate release is unambiguous

    const [strategy, released] = makeTurnAnalyzerStrategy({ inferenceSecs });
    await strategy.setup(frameProcessorSetup(taskManager));
    await strategy.processFrame(
      new STTMetadataFrame({ serviceName: "stt", ttfsP99Latency: sttP99 }),
    );
    await strategy.processFrame(new VADUserStartedSpeakingFrame({ startSecs: 0.2 }));

    const vadTask = createTask(() =>
      strategy.processFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.2 })),
    );
    await sleep(inferenceSecs / 3); // land mid-inference
    await strategy.processFrame(
      new TranscriptionFrame({ userId: "", text: "hello", timestamp: "now", finalized: true }),
    );
    await vadTask;

    await waitFor(() => released.wait(), 1.0);

    await strategy.cleanup();
  });

  test("test_no_wait_for_transcript_releases_on_verdict", async () => {
    // With waitForTranscript=false the verdict alone releases the turn.
    //
    // No transcript is ever sent; release must follow analyzeEndOfTurn()
    // directly rather than the STT safety-net timer.
    const sttP99 = 5.0;

    const [strategy, released] = makeTurnAnalyzerStrategy({
      inferenceSecs: 0.1,
      waitForTranscript: false,
    });
    await strategy.setup(frameProcessorSetup(taskManager));
    await strategy.processFrame(
      new STTMetadataFrame({ serviceName: "stt", ttfsP99Latency: sttP99 }),
    );
    await strategy.processFrame(new VADUserStartedSpeakingFrame({ startSecs: 0.2 }));
    await strategy.processFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.2 }));

    await waitFor(() => released.wait(), 1.0);

    await strategy.cleanup();
  });
});
