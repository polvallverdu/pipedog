// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_turn_completion_user_turn_stop_strategy.py

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sleep } from "@pipedog/asyncio";

import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  EagerTranscriptionFrame,
  type Frame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMarkerResponseFrame,
  LLMMessagesAppendFrame,
  LLMTextFrame,
  type LLMUpdateSettingsFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  STTMetadataFrame,
  StartFrame,
  TranscriptionFrame,
  UserTurnCompletionFrame,
  UserTurnResponseCancelFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { LLMContext, type LLMContextMessage } from "../src/processors/aggregators/llm_context.ts";
import {
  LLMAssistantAggregator,
  LLMUserAggregator,
  LLMUserAggregatorParams,
} from "../src/processors/aggregators/llm_response_universal.ts";
import {
  type FrameDirection,
  FrameProcessor,
  FrameProcessorSetup,
} from "../src/processors/frame_processor.ts";
import { LLMService, type LLMServiceOptions } from "../src/services/llm_service.ts";
import { LLMSettings } from "../src/services/settings.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import {
  LLMTurnCompletionUserTurnStopStrategy,
  SpeechTimeoutUserTurnStopStrategy,
} from "../src/turns/user_stop/index.ts";
import { UserTurnCompletionConfig } from "../src/turns/user_turn_completion_mixin.ts";
import {
  EagerUserTurnStrategies,
  FilterIncompleteUserTurnStrategies,
  MergeMode,
  StrategyMode,
  UserTurnStrategiesParams,
} from "../src/turns/user_turn_strategies.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";

const SPEECH_TIMEOUT = 0.1;

/** Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`. */
function frameProcessorSetup(taskManager: BaseTaskManager): FrameProcessorSetup {
  return new FrameProcessorSetup({ clock: new SystemClock(), taskManager, pipelineWorker: null });
}

describe("TestLLMTurnCompletionUserTurnStopStrategy", () => {
  // Decides on the marker of the inference that answers the turn.
  let strategy: LLMTurnCompletionUserTurnStopStrategy;
  let decisions: number;
  let withdrawals: number;
  let pushed: Frame[];

  beforeEach(async () => {
    strategy = new LLMTurnCompletionUserTurnStopStrategy({
      config: new UserTurnCompletionConfig({ incompleteShortTimeout: 0.05 }),
    });
    await strategy.setup(frameProcessorSetup(new TaskManager()));
    decisions = 0;
    withdrawals = 0;
    pushed = [];

    strategy.eventHandler("on_user_turn_stopped", async () => {
      decisions += 1;
    });

    strategy.eventHandler("on_user_turn_speculation_cancelled", async () => {
      withdrawals += 1;
    });

    strategy.eventHandler("on_push_frame", async (_strategy, frame: Frame) => {
      pushed.push(frame);
    });
  });

  afterEach(async () => {
    await strategy.cleanup();
  });

  async function infer(options: { speculation?: boolean } = {}): Promise<LLMContextFrame> {
    const frame = new LLMContextFrame({
      context: new LLMContext(),
      speculation: options.speculation ?? false,
    });
    await strategy.processFrame(frame);
    return frame;
  }

  async function report(kind: string | null, inference: LLMContextFrame): Promise<void> {
    await strategy.processFrame(
      new UserTurnCompletionFrame({ kind, contextFrameId: inference.id }),
    );
  }

  test("test_it_turns_on_markers_in_the_llm_at_start", async () => {
    await strategy.processFrame(new StartFrame());

    expect(pushed.length).toEqual(1);
    const update = pushed[0] as LLMUpdateSettingsFrame;
    const delta = update.delta as LLMSettings;
    expect(delta.filterIncompleteUserTurns).toBe(true);
    expect(delta.userTurnCompletionConfig).toBe(strategy.config);
    expect(update.reachInactiveServices).toBe(true);
  });

  test("test_each_marker_gives_its_decision", async () => {
    for (const [kind, expected] of [
      ["complete", 1],
      ["short", 0],
      ["long", 0],
      [null, 1],
    ] as const) {
      decisions = 0;
      await report(kind, await infer());
      expect(decisions).toEqual(expected);
      await strategy.handleUserTurnStarted();
    }
  });

  test("test_a_report_for_another_inference_is_ignored", async () => {
    const earlier = await infer();
    await infer();

    await report("complete", earlier);

    expect(decisions).toEqual(0);
  });

  test("test_speaking_again_waits_for_the_next_inference", async () => {
    const inference = await infer();
    await strategy.processFrame(new VADUserStartedSpeakingFrame());

    await report("complete", inference);

    expect(decisions).toEqual(0);
  });

  test("test_a_cancelled_answer_gets_no_decision", async () => {
    const inference = await infer();
    await strategy.processFrame(new UserTurnResponseCancelFrame());

    await report("complete", inference);

    expect(decisions).toEqual(0);
  });

  test("test_a_complete_speculative_answer_gets_a_decision", async () => {
    await report("complete", await infer({ speculation: true }));

    expect(decisions).toEqual(1);
  });

  test("test_an_incomplete_speculative_answer_is_withdrawn", async () => {
    // The committed turn brings an inference of its own, so nothing is re-prompted.
    await report("short", await infer({ speculation: true }));
    await sleep(0.15);

    expect(withdrawals).toEqual(1);
    expect(decisions).toEqual(0);
    expect(pushed).toEqual([]);
  });

  test("test_a_quiet_user_is_re_prompted_after_an_incomplete_turn", async () => {
    await report("short", await infer());
    await sleep(0.15);

    expect(decisions).toEqual(1);
    expect(pushed.length).toEqual(1);
    const reprompt = pushed[0] as LLMMessagesAppendFrame;
    expect(reprompt).toBeInstanceOf(LLMMessagesAppendFrame);
    expect(reprompt.runLlm).toBe(true);
    expect((reprompt.messages[0] as { content: string }).content).toEqual(
      strategy.config.shortPrompt,
    );
  });

  test("test_speaking_again_cancels_the_re_prompt", async () => {
    await report("short", await infer());
    await strategy.processFrame(new VADUserStartedSpeakingFrame());
    await sleep(0.15);

    expect(decisions).toEqual(0);
    expect(pushed).toEqual([]);
  });

  test("test_a_turn_ended_by_the_stop_timeout_is_still_re_prompted", async () => {
    await report("short", await infer());
    await strategy.handleUserTurnStopped();
    await sleep(0.15);

    expect(pushed.length).toEqual(1);
    expect(pushed[0]).toBeInstanceOf(LLMMessagesAppendFrame);
  });

  test("test_another_inference_cancels_the_re_prompt", async () => {
    await report("short", await infer());
    await infer();
    await sleep(0.15);

    expect(pushed).toEqual([]);
  });

  test("test_a_report_from_another_inference_cancels_the_re_prompt", async () => {
    await report("short", await infer());
    await report(null, new LLMContextFrame({ context: new LLMContext() }));
    await sleep(0.15);

    expect(pushed).toEqual([]);
  });

  test("test_a_later_complete_marker_cancels_the_re_prompt", async () => {
    await report("short", await infer());
    await report("complete", await infer());
    await sleep(0.15);

    expect(decisions).toEqual(1);
    expect(pushed).toEqual([]);
  });
});

/** Answers each inference with the next scripted reply, read through the marker mixin. */
class ScriptedMarkerLLM extends LLMService {
  protected _replies: string[];
  protected _delays: number[];
  inferences = 0;

  constructor(replies: string[], options: { delays?: number[] | null } & LLMServiceOptions = {}) {
    const { delays, ...rest } = options;
    super({ ...rest, settings: new LLMSettings({ model: "test-model" }) });
    this._replies = [...replies];
    this._delays = [...(delays ?? [])];
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (!(frame instanceof LLMContextFrame)) {
      await this.pushFrame(frame, direction);
      return;
    }

    this.inferences += 1;
    const reply = this._replies.shift() as string;
    await sleep(this._delays.length > 0 ? (this._delays.shift() as number) : 0);
    await this.pushFrame(new LLMFullResponseStartFrame());
    await this._pushLlmText(reply);
    await this.pushFrame(new LLMFullResponseEndFrame());
  }
}

/** Records the spoken text and LLMMarkerResponseFrame kinds that reach the output. */
class OutputRecorder extends FrameProcessor {
  spoken: string[] = [];
  markerKinds: (string | null)[] = [];

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof LLMTextFrame) {
      this.spoken.push(frame.text);
    } else if (frame instanceof LLMMarkerResponseFrame) {
      this.markerKinds.push(frame.kind);
    }
    await this.pushFrame(frame, direction);
  }
}

/** `(role, first character of content)` for each message, as upstream compares them. */
function roles(context: LLMContext): [string, string][] {
  return context
    .getMessages()
    .map((m) => [
      (m as { role: string }).role,
      String((m as LLMContextMessage & { content: string }).content).slice(0, 1),
    ]);
}

describe("TestFilteringIncompleteTurns", () => {
  // Filtering incomplete turns end to end: aggregators, a marker-reading LLM, the output.

  async function run(
    replies: string[],
    framesToSend: Frame[],
    options: { stopMode?: StrategyMode; config?: UserTurnCompletionConfig | null } = {},
  ): Promise<[OutputRecorder, LLMContext]> {
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new FilterIncompleteUserTurnStrategies({
          stop: [new SpeechTimeoutUserTurnStopStrategy({ userSpeechTimeout: SPEECH_TIMEOUT })],
          config: options.config ?? null,
        }),
        userTurnStrategiesParams: new UserTurnStrategiesParams({
          stopMode: options.stopMode ?? StrategyMode.ALL,
        }),
      }),
    });
    const recorder = new OutputRecorder();

    await runTest(
      new Pipeline([
        userAggregator,
        new ScriptedMarkerLLM(replies),
        recorder,
        new LLMAssistantAggregator(context),
      ]),
      { framesToSend },
    );
    return [recorder, context];
  }

  function utterance(text: string): Frame[] {
    return [
      new VADUserStartedSpeakingFrame(),
      new TranscriptionFrame({ text, userId: "", timestamp: "now" }),
      new SleepFrame(),
      new VADUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: SPEECH_TIMEOUT + 0.2 }),
    ];
  }

  test("test_a_complete_turn_is_answered", async () => {
    const [recorder, context] = await run(
      ["● Sure, Boston it is."],
      utterance("Book a flight to Boston"),
    );

    expect(recorder.spoken).toEqual(["Sure, Boston it is."]);
    const messages = context.getMessages() as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.content.startsWith("●")).toBe(true);
  });

  test("test_an_incomplete_turn_waits_for_the_rest", async () => {
    const [recorder, context] = await run(
      ["◐", "● Sure, Boston it is."],
      [...utterance("Book a flight"), ...utterance("to Boston")],
    );

    expect(recorder.spoken).toEqual(["Sure, Boston it is."]);
    expect(roles(context)).toEqual([
      ["user", "B"],
      ["assistant", "◐"],
      ["user", "t"],
      ["assistant", "●"],
    ]);
  });

  test("test_a_quiet_user_is_re_prompted_in_either_stop_mode", async () => {
    for (const stopMode of [StrategyMode.ALL, StrategyMode.FIRST]) {
      const [recorder] = await run(
        ["◐", "● Are you still there?"],
        [...utterance("Book a flight"), new SleepFrame({ sleep: 0.5 })],
        {
          stopMode,
          config: new UserTurnCompletionConfig({ incompleteShortTimeout: 0.2 }),
        },
      );

      expect(recorder.spoken).toEqual(["Are you still there?"]);
    }
  });

  test("test_words_after_the_inference_are_answered_without_a_re_prompt", async () => {
    const [recorder] = await run(
      ["◐", "● Sure, Boston it is.", "● Are you still there?"],
      [
        new VADUserStartedSpeakingFrame(),
        new TranscriptionFrame({ text: "Book a flight", userId: "", timestamp: "now" }),
        new SleepFrame(),
        new VADUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: SPEECH_TIMEOUT + 0.05 }),
        new TranscriptionFrame({ text: "to Boston", userId: "", timestamp: "now" }),
        new SleepFrame({ sleep: 0.6 }),
      ],
      { config: new UserTurnCompletionConfig({ incompleteShortTimeout: 0.3 }) },
    );

    expect(recorder.spoken).toEqual(["Sure, Boston it is."]);
  });

  test("test_every_response_reports_its_marker", async () => {
    const [recorder] = await run(
      ["◐", "● Sure, Boston it is."],
      [...utterance("Book a flight"), ...utterance("to Boston")],
    );

    expect(recorder.markerKinds).toEqual(["short", "complete"]);
  });
});

describe("TestFilteringIncompleteTurnsWithEagerEndOfTurn", () => {
  // The marker strategy decides on an eager answer while the turn commits, in either order.
  let llm: ScriptedMarkerLLM;

  async function run(
    replies: string[],
    framesToSend: Frame[],
    options: { delays?: number[] | null } = {},
  ): Promise<[OutputRecorder, LLMContext]> {
    const context = new LLMContext();
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new FilterIncompleteUserTurnStrategies(),
        userTurnStrategiesParams: new UserTurnStrategiesParams({
          startMergeMode: MergeMode.EXTEND,
          stopMergeMode: MergeMode.EXTEND,
        }),
      }),
    });
    const recorder = new OutputRecorder();
    const recommendation = new STTMetadataFrame({
      serviceName: "flux",
      ttfsP99Latency: 0.0,
      userTurnStrategies: new EagerUserTurnStrategies(),
    });
    llm = new ScriptedMarkerLLM(replies, { delays: options.delays ?? null });

    await runTest(
      new Pipeline([userAggregator, llm, recorder, new LLMAssistantAggregator(context)]),
      { framesToSend: [recommendation, new SleepFrame(), ...framesToSend] },
    );
    return [recorder, context];
  }

  function turn(text: string): Frame[] {
    return [
      new ProposedUserStartedSpeakingFrame(),
      new SleepFrame(),
      new EagerTranscriptionFrame({ text, userId: "user", timestamp: "now" }),
      new SleepFrame({ sleep: 0.1 }),
      new TranscriptionFrame({ text, userId: "user", timestamp: "now" }),
      new SleepFrame(),
      new ProposedUserStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.8 }),
    ];
  }

  function assertAnsweredOnce(recorder: OutputRecorder, context: LLMContext): void {
    expect(recorder.spoken).toEqual(["Sure, Boston it is."]);
    expect(roles(context)).toEqual([
      ["user", "B"],
      ["assistant", "●"],
    ]);
  }

  test("test_a_complete_eager_answer_is_spoken_once_the_turn_commits", async () => {
    const [recorder, context] = await run(
      ["● Sure, Boston it is."],
      turn("Book a flight to Boston"),
    );

    assertAnsweredOnce(recorder, context);
  });

  test("test_a_slow_complete_eager_answer_is_generated_once", async () => {
    // The external stop strategy asks for the stop again while the turn waits
    // for the marker, and the eager strategy confirms it again.
    const [recorder, context] = await run(
      ["● Sure, Boston it is."],
      turn("Book a flight to Boston"),
      { delays: [0.8] },
    );

    assertAnsweredOnce(recorder, context);
    expect(llm.inferences).toEqual(1);
  });

  test("test_an_incomplete_eager_answer_is_dropped_and_the_committed_turn_answered", async () => {
    const [recorder, context] = await run(
      ["◐", "● Sure, Boston it is."],
      turn("Book a flight to Boston"),
    );

    assertAnsweredOnce(recorder, context);
  });

  test("test_an_eager_answer_marked_incomplete_after_the_commit_is_answered_again", async () => {
    const [recorder, context] = await run(
      ["◐", "● Sure, Boston it is."],
      turn("Book a flight to Boston"),
      { delays: [0.45, 0] },
    );

    assertAnsweredOnce(recorder, context);
  });

  test("test_an_eager_answer_marked_incomplete_as_the_turn_commits_is_answered_again", async () => {
    // The marker arrives as the turn commits, so the speculation is withdrawn
    // while the eager strategy confirms it.
    const [recorder, context] = await run(
      ["◐", "● Sure, Boston it is."],
      turn("Book a flight to Boston"),
      { delays: [0.3, 0] },
    );

    assertAnsweredOnce(recorder, context);
  });
});
