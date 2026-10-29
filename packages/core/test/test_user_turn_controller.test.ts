// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_turn_controller.py

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { createTask, Event, monotonic, sleep, waitFor } from "@pipedog/asyncio";

import { type BaseTurnAnalyzer, EndOfTurnState } from "../src/audio/turn/base_turn_analyzer.ts";
import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  BotStartedSpeakingFrame,
  type Frame,
  LLMContextFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  STTMetadataFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  UserTurnCompletionFrame,
  UserTurnInferenceCompletedFrame,
  UserTurnResponseCancelFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import { UserTurnResumedParams, UserTurnSpeculation } from "../src/turns/types.ts";
import {
  BaseUserTurnStartStrategy,
  ExternalUserTurnStartStrategy,
  TranscriptionUserTurnStartStrategy,
  type UserTurnStartedParams,
  VADUserTurnStartStrategy,
} from "../src/turns/user_start/index.ts";
import { MinWordsUserTurnStartStrategy } from "../src/turns/user_start/min_words_user_turn_start_strategy.ts";
import type { ReportUserTurnStoppedOptions } from "../src/turns/user_stop/base_user_turn_stop_strategy.ts";
import {
  BaseUserTurnStopStrategy,
  LLMTurnCompletionUserTurnStopStrategy,
  SpeechTimeoutUserTurnStopStrategy,
  TurnAnalyzerUserTurnStopStrategy,
  type UserTurnStoppedParams,
} from "../src/turns/user_stop/index.ts";
import type { TurnAnalyzerUserTurnStopStrategyOptions } from "../src/turns/user_stop/turn_analyzer_user_turn_stop_strategy.ts";
import { UserTurnCompletionConfig } from "../src/turns/user_turn_completion_mixin.ts";
import { UserTurnController } from "../src/turns/user_turn_controller.ts";
import {
  ExternalUserTurnStrategies,
  StrategyMode,
  UserTurnStrategies,
  UserTurnStrategiesParams,
} from "../src/turns/user_turn_strategies.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";
import type { BaseObject } from "../src/utils/base_object.ts";
import { logger } from "../src/utils/logger.ts";

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

  // Skipped: exercises the deprecated ExternalUserTurnCompletionStopStrategy,
  // which is not ported. A decision made while the user speaks ending the turn
  // only once they stop is covered by TestStopModeAll below.
  test.skip("test_completion_dropped_while_user_speaking", () => {});

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

  // Skipped: exercises the deprecated `deferred()` wrapper, which is not ported.
  test.skip("test_deferred_wrapper_skips_stopped", () => {});

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

  test("test_a_turn_ended_by_the_timeout_keeps_a_confirmation", async () => {
    // The stop timeout ends the turn with what the decisions said, a confirmation included.
    const confirming = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({ stop: [confirming, onInference] }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();
    const stops: UserTurnStoppedParams[] = [];

    controller.eventHandler(
      "on_user_turn_stopped",
      async (_controller, _strategy, params: UserTurnStoppedParams) => {
        stops.push(params);
      },
    );

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    await confirming.speculate();
    await confirming.confirm();
    await sleep(USER_TURN_STOP_TIMEOUT + 0.1);

    expect(stops.length).toEqual(1);
    expect(stops[0]!.confirmsSpeculation).toBe(true);
    await controller.cleanup();
  });

  test("test_the_stop_timeout_waits_for_a_scheduled_decision", async () => {
    const scheduled = new ScheduledDecisionStopStrategy();
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({ stop: [scheduled] }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();
    const stops: (BaseUserTurnStopStrategy | null)[] = [];

    controller.eventHandler("on_user_turn_stopped", async (_controller, strategy) => {
      stops.push(strategy);
    });

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    await sleep(USER_TURN_STOP_TIMEOUT * 2 + 0.1);
    expect(stops).toEqual([]);

    scheduled.scheduled = false;
    await sleep(USER_TURN_STOP_TIMEOUT + 0.1);
    expect(stops).toEqual([null]);
    await controller.cleanup();
  });

  async function startWithTheMarker(): Promise<{
    controller: UserTurnController;
    marker: LLMTurnCompletionUserTurnStopStrategy;
    stops: (BaseUserTurnStopStrategy | null)[];
    timeouts: null[];
  }> {
    const user = new DecidingStopStrategy();
    const marker = new LLMTurnCompletionUserTurnStopStrategy({
      config: new UserTurnCompletionConfig({
        incompleteLongTimeout: USER_TURN_STOP_TIMEOUT * 3,
      }),
    });
    const controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({ stop: [user, marker] }),
      userTurnStopTimeout: USER_TURN_STOP_TIMEOUT,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();
    const stops: (BaseUserTurnStopStrategy | null)[] = [];
    const timeouts: null[] = [];

    controller.eventHandler("on_user_turn_stopped", async (_controller, strategy) => {
      stops.push(strategy);
    });

    controller.eventHandler("on_user_turn_stop_timeout", async () => {
      timeouts.push(null);
    });

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await controller.processFrame(new VADUserStoppedSpeakingFrame());
    await user.decide();
    return { controller, marker, stops, timeouts };
  }

  test("test_a_turn_the_llm_needs_more_time_on_waits_for_the_marker", async () => {
    // After ○, the turn stays open until the marker strategy's own timeout decides.
    const { controller, marker, stops, timeouts } = await startWithTheMarker();
    const inference = new LLMContextFrame({ context: new LLMContext() });
    await controller.processFrame(inference);
    await controller.processFrame(
      new UserTurnCompletionFrame({ kind: "long", contextFrameId: inference.id }),
    );

    await sleep(USER_TURN_STOP_TIMEOUT * 2);
    expect(stops).toEqual([]);

    await sleep(USER_TURN_STOP_TIMEOUT * 2);
    expect(stops).toEqual([marker]);
    expect(timeouts).toEqual([]);
    await controller.cleanup();
  });

  test("test_a_marker_that_never_comes_still_times_out", async () => {
    const { controller, stops, timeouts } = await startWithTheMarker();
    await controller.processFrame(new LLMContextFrame({ context: new LLMContext() }));

    await sleep(USER_TURN_STOP_TIMEOUT + 0.1);
    expect(stops).toEqual([null]);
    expect(timeouts).toEqual([null]);
    await controller.cleanup();
  });

  test("test_external_turn_decided_while_vad_hears_speech_ends_once_vad_stops", async () => {
    // The service says the user is done while local VAD still hears a breath.
    for (const stopMode of [StrategyMode.ALL, StrategyMode.FIRST]) {
      await decideExternalTurnWhileVadHearsSpeech(stopMode);
    }
  });

  async function decideExternalTurnWhileVadHearsSpeech(stopMode: StrategyMode): Promise<void> {
    const controller = new UserTurnController({
      userTurnStrategies: new ExternalUserTurnStrategies(),
      userTurnStrategiesParams: new UserTurnStrategiesParams({ stopMode }),
      userTurnStopTimeout: 3.0,
    });
    await controller.setup(frameProcessorSetup(taskManager));
    await controller.start();
    const stops: (BaseUserTurnStopStrategy | null)[] = [];
    const timeouts: null[] = [];

    controller.eventHandler("on_user_turn_stopped", async (_controller, strategy) => {
      stops.push(strategy);
    });

    controller.eventHandler("on_user_turn_stop_timeout", async () => {
      timeouts.push(null);
    });

    await controller.processFrame(new UserStartedSpeakingFrame());
    await controller.processFrame(new UserStoppedSpeakingFrame());
    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await controller.processFrame(
      new TranscriptionFrame({ text: "Hello", userId: "", timestamp: "now" }),
    );
    // The transcription settles, and the strategy decides while VAD still
    // hears speech.
    await sleep(0.7);
    expect(stops).toEqual([]);

    await controller.processFrame(new VADUserStoppedSpeakingFrame());

    expect(stops.length).toEqual(1);
    expect(timeouts).toEqual([]);
    await controller.cleanup();
  }

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

  // Skipped: exercises the deprecated `deferred()` wrapper, which is not ported.
  test.skip("test_deferring_a_strategy_keeps_its_proposal_resolution", () => {});

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

    class SpyNeverStopStrategy extends BaseUserTurnStopStrategy {
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

  // Skipped: exercises the deprecated `deferred()` wrapper, which is not ported.
  test.skip("test_deferred_forwards_both_callbacks", () => {});

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

/** A stop strategy with a decision of its own scheduled while `scheduled`. */
class ScheduledDecisionStopStrategy extends BaseUserTurnStopStrategy {
  scheduled = true;

  override get decisionScheduled(): boolean {
    return this.scheduled;
  }
}

/**
 * A stop strategy that decides the user is done when a test says so.
 *
 * Upstream's also takes a deprecated `ProcessFrameResult` to return from
 * `process_frame`, which is not ported.
 */
class DecidingStopStrategy extends BaseUserTurnStopStrategy {
  frames: Frame[] = [];
  protected _onInference: boolean;

  constructor(options: { onInference?: boolean } = {}) {
    super();
    this._onInference = options.onInference ?? false;
  }

  override get waitsForInference(): boolean {
    return this._onInference;
  }

  override async processFrame(frame: Frame): Promise<void> {
    this.frames.push(frame);
  }

  async decide(options: ReportUserTurnStoppedOptions = {}): Promise<void> {
    await this.reportUserTurnStopped(options);
  }

  async speculate(): Promise<void> {
    await this.startUserTurnSpeculation(new UserTurnSpeculation({ text: "Hi" }));
  }

  async confirm(): Promise<void> {
    await this.reportUserTurnStopped({ confirmsSpeculation: true });
  }
}

describe("TestStopModeAll", () => {
  // By default the turn ends once every stop strategy has decided.
  let taskManager: TaskManager;
  let stops: [BaseUserTurnStopStrategy | null, UserTurnStoppedParams][];
  let controller: UserTurnController;

  beforeEach(() => {
    taskManager = new TaskManager();
    stops = [];
  });

  afterEach(async () => {
    await controller.cleanup();
  });

  async function start(
    stop: BaseUserTurnStopStrategy[],
    options: { start?: BaseUserTurnStartStrategy[] | null; stopMode?: StrategyMode } = {},
  ): Promise<void> {
    controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({
        start: options.start ?? [new VADUserTurnStartStrategy()],
        stop,
      }),
      userTurnStrategiesParams: new UserTurnStrategiesParams({
        stopMode: options.stopMode ?? StrategyMode.ALL,
      }),
    });
    await controller.setup(frameProcessorSetup(taskManager));

    controller.eventHandler(
      "on_user_turn_stopped",
      async (_controller, strategy, params: UserTurnStoppedParams) => {
        stops.push([strategy, params]);
      },
    );
  }

  async function speak(): Promise<void> {
    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await controller.processFrame(new VADUserStoppedSpeakingFrame());
  }

  const stopStrategies = () => stops.map(([s]) => s);

  function recordInferences(): [BaseUserTurnStopStrategy | null, unknown][] {
    const inferences: [BaseUserTurnStopStrategy | null, unknown][] = [];

    controller.eventHandler(
      "on_user_turn_inference_triggered",
      async (_controller, strategy, speculation) => {
        inferences.push([strategy, speculation]);
      },
    );

    return inferences;
  }

  function recordResumes(): UserTurnResumedParams[] {
    const resumes: UserTurnResumedParams[] = [];

    controller.eventHandler("on_user_turn_resumed", async (_controller, params) => {
      resumes.push(params);
    });

    return resumes;
  }

  test("test_the_turn_ends_once_every_strategy_decides", async () => {
    const first = new DecidingStopStrategy();
    const last = new DecidingStopStrategy();
    await start([first, last]);
    await speak();

    await first.decide();
    expect(stops).toEqual([]);

    await last.decide();
    expect(stopStrategies()).toEqual([last]);
  });

  test("test_the_first_decision_ends_the_turn_in_first_mode", async () => {
    const first = new DecidingStopStrategy();
    const last = new DecidingStopStrategy();
    await start([first, last], { stopMode: StrategyMode.FIRST });
    await speak();

    await first.decide();
    await last.decide();

    expect(stopStrategies()).toEqual([first]);
  });

  test("test_a_first_list_waits_for_the_decision_on_the_inference", async () => {
    const first = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([first, onInference], { stopMode: StrategyMode.FIRST });
    const inferences = recordInferences();
    await speak();

    await first.decide();
    expect(inferences.length).toEqual(1);
    expect(stops).toEqual([]);

    await onInference.decide();
    expect(stopStrategies()).toEqual([onInference]);
  });

  test("test_a_first_list_keeps_a_confirmation_until_the_turn_ends", async () => {
    const first = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([first, onInference], { stopMode: StrategyMode.FIRST });
    await speak();

    await first.speculate();
    await first.confirm();
    await onInference.decide();

    const [, params] = stops[0]!;
    expect(params.confirmsSpeculation).toBe(true);
  });

  test("test_new_speech_clears_the_decisions", async () => {
    const first = new DecidingStopStrategy();
    const last = new DecidingStopStrategy();
    await start([first, last]);
    await speak();
    await first.decide();

    await speak();
    await last.decide();
    expect(stops).toEqual([]);

    await first.decide();
    expect(stopStrategies()).toEqual([first]);
  });

  test("test_a_decision_made_while_the_user_speaks_counts", async () => {
    const first = new DecidingStopStrategy();
    const last = new DecidingStopStrategy();
    await start([first, last]);
    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await first.decide();
    await controller.processFrame(new VADUserStoppedSpeakingFrame());

    await last.decide();

    expect(stopStrategies()).toEqual([last]);
  });

  test("test_the_turn_does_not_end_while_the_user_speaks", async () => {
    const first = new DecidingStopStrategy();
    const last = new DecidingStopStrategy();
    await start([first, last]);
    await controller.processFrame(new VADUserStartedSpeakingFrame());

    await first.decide();
    await last.decide();

    expect(stops).toEqual([]);
  });

  test("test_a_turn_decided_while_the_user_speaks_ends_once_they_stop", async () => {
    const first = new DecidingStopStrategy();
    const last = new DecidingStopStrategy();
    await start([first, last]);
    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await first.decide();
    await last.decide();

    await controller.processFrame(new VADUserStoppedSpeakingFrame());

    expect(stopStrategies()).toEqual([last]);
  });

  test("test_a_first_list_ends_a_turn_decided_while_the_user_speaks_once_they_stop", async () => {
    const strategy = new DecidingStopStrategy();
    await start([strategy], { stopMode: StrategyMode.FIRST });
    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await strategy.decide();
    expect(stops).toEqual([]);

    await controller.processFrame(new VADUserStoppedSpeakingFrame());

    expect(stopStrategies()).toEqual([strategy]);
  });

  test("test_a_cancelled_answer_voids_the_decisions_made_on_it", async () => {
    // A decision on the inference is about the answer, so it goes with it.
    const user = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([user, onInference]);
    await speak();
    await user.speculate();
    await onInference.decide();

    await controller.processFrame(new UserTurnResponseCancelFrame());
    await user.decide();

    expect(stops).toEqual([]);
  });

  test("test_a_cancelled_answer_keeps_the_decisions_on_the_user", async () => {
    // A decision on the user says nothing about the answer, so it outlives it.
    const user = new DecidingStopStrategy();
    const eager = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([user, eager, onInference]);
    const inferences = recordInferences();
    await speak();
    await eager.speculate();
    await user.decide();

    await controller.processFrame(new UserTurnResponseCancelFrame());
    await eager.decide();

    expect(inferences.map(([, speculation]) => speculation === null)).toEqual([false, true]);
  });

  test("test_a_confirmation_outlives_the_answer_it_confirmed", async () => {
    // The turn's answer runs again for a decision that confirmed a cancelled one.
    const confirming = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([confirming, onInference]);
    const inferences: (BaseUserTurnStopStrategy | null)[] = [];

    controller.eventHandler("on_user_turn_inference_triggered", async (_controller, strategy) => {
      inferences.push(strategy);
    });

    await speak();
    await confirming.speculate();
    await confirming.confirm();
    await controller.processFrame(new UserTurnResponseCancelFrame());
    expect(inferences).toEqual([confirming, confirming]);

    await onInference.decide();
    const [, params] = stops[0]!;
    expect(params.confirmsSpeculation).toBe(false);
  });

  test("test_a_withdrawn_speculation_reaches_every_stop_strategy", async () => {
    const withdrawing = new DecidingStopStrategy();
    const other = new DecidingStopStrategy();
    await start([withdrawing, other]);
    await speak();

    await withdrawing.cancelUserTurnSpeculation();

    expect(other.frames.at(-1)).toBeInstanceOf(UserTurnResponseCancelFrame);
  });

  test("test_each_turn_needs_its_own_decisions", async () => {
    // Decisions don't carry over into a turn that starts without speech frames.
    const first = new DecidingStopStrategy();
    const last = new DecidingStopStrategy();
    await start([first, last], { start: [new TranscriptionUserTurnStartStrategy()] });
    await controller.processFrame(
      new TranscriptionFrame({ text: "Hi", userId: "", timestamp: "" }),
    );
    await first.decide();
    await last.decide();

    await controller.processFrame(
      new TranscriptionFrame({ text: "Hi", userId: "", timestamp: "" }),
    );
    await last.decide();

    expect(stops.length).toEqual(1);
  });

  // Skipped: exercises the deprecated `deferred()` wrapper, which is not ported.
  test.skip("test_a_deferred_strategy_decides_as_the_one_it_wraps", () => {});

  test("test_every_strategy_sees_every_frame", async () => {
    // Upstream's first strategy returns the deprecated ProcessFrameResult.STOP,
    // which is not ported: strategies return nothing.
    const blocking = new DecidingStopStrategy();
    const other = new DecidingStopStrategy();
    await start([blocking, other]);

    await speak();

    expect(other.frames.length).toEqual(2);
  });

  test("test_the_inference_waits_for_every_strategy_that_listens_to_the_user", async () => {
    const first = new DecidingStopStrategy();
    const second = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([first, second, onInference]);
    const inferences = recordInferences();
    await speak();

    await first.decide();
    expect(inferences).toEqual([]);

    await second.decide();
    expect(inferences.map(([s]) => s)).toEqual([second]);
    expect(stops).toEqual([]);

    await onInference.decide();
    expect(stopStrategies()).toEqual([onInference]);
  });

  test("test_a_list_that_only_waits_for_the_inference_warns", async () => {
    // With no stop strategy listening to the user, only the stop timeout runs the inference.
    const messages: string[] = [];
    const warning = spyOn(logger, "warning").mockImplementation((m: string) => {
      messages.push(m);
    });
    try {
      await start([new DecidingStopStrategy({ onInference: true })]);
      await controller.updateStrategies(
        new UserTurnStrategies({
          stop: [new DecidingStopStrategy(), new DecidingStopStrategy({ onInference: true })],
        }),
      );
    } finally {
      warning.mockRestore();
    }

    const warned = messages.filter((m) => m.includes("waits for the turn's inference"));
    expect(warned.length).toEqual(1);
  });

  test("test_the_inference_runs_once_per_round_of_decisions", async () => {
    const first = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([first, onInference]);
    const inferences = recordInferences();
    await speak();

    await first.decide();
    await first.decide();
    expect(inferences.length).toEqual(1);

    await speak();
    await first.decide();
    expect(inferences.length).toEqual(2);
  });

  test("test_a_speculation_is_the_turns_answer", async () => {
    const eager = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([eager, onInference]);
    const inferences = recordInferences();
    await speak();

    await eager.speculate();
    await eager.confirm();

    expect(inferences.map(([, speculation]) => speculation === null)).toEqual([false]);
  });

  test("test_a_withdrawn_speculation_lets_the_inference_run", async () => {
    const eager = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([eager, onInference]);
    const inferences = recordInferences();
    await speak();

    await eager.speculate();
    await eager.cancelUserTurnSpeculation();
    await eager.decide();

    expect(inferences.map(([, speculation]) => speculation === null)).toEqual([false, true]);
  });

  test("test_speaking_again_in_an_open_turn_resumes_it", async () => {
    await start([new DecidingStopStrategy(), new DecidingStopStrategy()]);
    const resumes = recordResumes();
    await speak();

    await speak();

    expect(resumes).toEqual([
      new UserTurnResumedParams({ enableInterruptions: true, inferenceTriggered: false }),
    ]);
  });

  test("test_a_resume_after_the_inference_was_triggered_says_so", async () => {
    const first = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([first, onInference]);
    const resumes = recordResumes();
    await speak();
    await first.decide();

    await speak();

    expect(resumes.map((p) => p.inferenceTriggered)).toEqual([true]);
  });

  test("test_one_speech_reported_twice_resumes_the_turn_once", async () => {
    await start([new DecidingStopStrategy(), new DecidingStopStrategy()]);
    const resumes = recordResumes();
    await speak();

    await controller.processFrame(new VADUserStartedSpeakingFrame());
    await controller.processFrame(new UserStartedSpeakingFrame());

    expect(resumes.length).toEqual(1);
  });

  // Skipped: exercises the deprecated `trigger_user_turn_finalized()`, which is
  // not ported (`reportUserTurnStopped()` replaces it).
  test.skip("test_the_deprecated_finalized_trigger_still_decides", () => {});

  test("test_the_turn_end_combines_the_decisions", async () => {
    // A turn end announced elsewhere, or confirming a speculation, applies to the whole turn.
    const announced = new DecidingStopStrategy();
    const confirming = new DecidingStopStrategy();
    await start([announced, confirming]);
    await speak();

    await confirming.speculate();
    await announced.reportUserTurnStopped({ enableUserSpeakingFrames: false });
    await confirming.confirm();

    const [, params] = stops[0]!;
    expect(params.enableUserSpeakingFrames).toBe(false);
    expect(params.confirmsSpeculation).toBe(true);
  });

  test("test_confirming_a_withdrawn_speculation_runs_the_turns_answer", async () => {
    // A confirmation that crosses its speculation's withdrawal confirms nothing.
    const confirming = new DecidingStopStrategy();
    const onInference = new DecidingStopStrategy({ onInference: true });
    await start([confirming, onInference]);
    const inferences: unknown[] = [];

    controller.eventHandler(
      "on_user_turn_inference_triggered",
      async (_controller, _strategy, speculation) => {
        inferences.push(speculation);
      },
    );

    await speak();
    await confirming.speculate();
    await controller.processFrame(new UserTurnResponseCancelFrame());
    await confirming.confirm();
    expect(inferences.map((s) => s === null)).toEqual([false, true]);

    await onInference.decide();
    const [, params] = stops[0]!;
    expect(params.confirmsSpeculation).toBe(false);
  });
});

/**
 * A start strategy that decides the user started when a test says so.
 *
 * Upstream's also takes a deprecated `ProcessFrameResult` to return from
 * `process_frame`, which is not ported.
 */
class DecidingStartStrategy extends BaseUserTurnStartStrategy {
  frames: Frame[] = [];

  override async processFrame(frame: Frame): Promise<void> {
    this.frames.push(frame);
  }

  async decide(
    options: { enableInterruptions?: boolean; enableUserSpeakingFrames?: boolean } = {},
  ): Promise<void> {
    await this.reportUserTurnStarted(options);
  }
}

describe("TestStartModeAll", () => {
  // With StrategyMode.ALL the turn starts once every start strategy has decided.
  let taskManager: TaskManager;
  let starts: [BaseUserTurnStartStrategy | null, UserTurnStartedParams][];
  let stop: DecidingStopStrategy;
  let controller: UserTurnController;

  beforeEach(() => {
    taskManager = new TaskManager();
    starts = [];
    stop = new DecidingStopStrategy();
  });

  afterEach(async () => {
    await controller.cleanup();
  });

  async function start(
    startStrategies: BaseUserTurnStartStrategy[],
    options: { startMode?: StrategyMode } = {},
  ): Promise<void> {
    controller = new UserTurnController({
      userTurnStrategies: new UserTurnStrategies({ start: startStrategies, stop: [stop] }),
      userTurnStrategiesParams: new UserTurnStrategiesParams({
        startMode: options.startMode ?? StrategyMode.ALL,
      }),
    });
    await controller.setup(frameProcessorSetup(taskManager));

    controller.eventHandler(
      "on_user_turn_started",
      async (_controller, strategy, params: UserTurnStartedParams) => {
        starts.push([strategy, params]);
      },
    );
  }

  test("test_the_turn_starts_once_every_strategy_decides", async () => {
    const first = new DecidingStartStrategy();
    const last = new DecidingStartStrategy();
    await start([first, last]);

    await first.decide();
    expect(starts).toEqual([]);

    await last.decide();
    expect(starts.map(([s]) => s)).toEqual([last]);
  });

  test("test_the_first_decision_starts_the_turn_in_first_mode", async () => {
    const first = new DecidingStartStrategy();
    const last = new DecidingStartStrategy();
    await start([first, last], { startMode: StrategyMode.FIRST });

    await first.decide();

    expect(starts.map(([s]) => s)).toEqual([first]);
  });

  test("test_every_strategy_sees_every_frame", async () => {
    // Upstream's first strategy returns the deprecated ProcessFrameResult.STOP,
    // which is not ported: strategies return nothing.
    const blocking = new DecidingStartStrategy();
    const other = new DecidingStartStrategy();
    await start([blocking, other]);

    await controller.processFrame(new VADUserStartedSpeakingFrame());

    expect(other.frames.length).toEqual(1);
  });

  test("test_the_turn_start_combines_the_decisions", async () => {
    const quiet = new DecidingStartStrategy();
    const other = new DecidingStartStrategy();
    await start([quiet, other]);

    await quiet.decide({ enableInterruptions: false });
    await other.decide();

    const [, params] = starts[0]!;
    expect(params.enableInterruptions).toBe(false);
  });

  // Skipped: exercises the deprecated ProcessFrameResult.STOP in a
  // StrategyMode.FIRST list and its DeprecationWarning, which are not ported.
  test.skip("test_a_first_list_still_honors_a_stop_with_a_warning", () => {});

  // Skipped: checks for the absence of the ProcessFrameResult
  // DeprecationWarning, which is not ported.
  test.skip("test_a_wake_phrase_alone_in_a_first_list_does_not_warn", () => {});

  // Skipped: checks for the absence of the ProcessFrameResult
  // DeprecationWarning, which is not ported.
  test.skip("test_a_wake_phrase_in_an_all_list_does_not_warn", () => {});

  test("test_each_turn_needs_its_own_decisions", async () => {
    const first = new DecidingStartStrategy();
    const last = new DecidingStartStrategy();
    await start([first, last]);
    await first.decide();
    await last.decide();
    await stop.decide();

    await last.decide();

    expect(starts.length).toEqual(1);
  });
});
