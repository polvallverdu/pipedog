// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_eager_user_turn_strategies.py

import { describe, expect, test } from "bun:test";

import { sleep } from "@pipecat-ts/asyncio";

import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  EagerEndOfTurnCancelFrame,
  EagerTranscriptionFrame,
  type Frame,
  FunctionCallFromLLM,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  LLMUserAggregator,
  LLMUserAggregatorParams,
} from "../src/processors/aggregators/llm_response_universal.ts";
import {
  type FrameDirection,
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import type { FunctionCallParams } from "../src/services/llm_service.ts";
import { LLMService, type LLMServiceOptions } from "../src/services/llm_service.ts";
import { LLMSettings } from "../src/services/settings.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import type { UserTurnSpeculation } from "../src/turns/types.ts";
import {
  deferred,
  type EagerMatchPolicy,
  EagerUserTurnStopStrategy,
  ExactMatch,
} from "../src/turns/user_stop/index.ts";
import { EagerUserTurnStrategies } from "../src/turns/user_turn_strategies.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";

// Imported upstream but unused there too; kept so the import lists diff cleanly.
void UserStartedSpeakingFrame;

/**
 * Port of `tests/frame_processor_helpers.frame_processor_setup`: build a setup
 * configuration for a processor used outside a pipeline.
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

function aggregator(
  context: LLMContext,
  options: {
    userTurnStopTimeout?: number;
    matchPolicy?: EagerMatchPolicy | null;
    speculationTimeout?: number;
  } = {},
): LLMUserAggregator {
  const { userTurnStopTimeout = 5.0, ...kwargs } = options;
  return new LLMUserAggregator(context, {
    params: new LLMUserAggregatorParams({
      userTurnStrategies: new EagerUserTurnStrategies(kwargs),
      userTurnStopTimeout,
    }),
  });
}

function eager(text: string): EagerTranscriptionFrame {
  return new EagerTranscriptionFrame({ text, userId: "user", timestamp: "2026-09-03T00:00:00Z" });
}

function final(text: string): TranscriptionFrame {
  return new TranscriptionFrame({ text, userId: "user", timestamp: "2026-09-03T00:00:00Z" });
}

function ofType<T extends Frame>(
  frames: readonly Frame[],
  cls: abstract new (...args: never[]) => T,
): T[] {
  return frames.filter((f): f is T => f instanceof cls);
}

describe("TestEagerUserTurnStrategies", () => {
  test("test_eager_end_of_turn_runs_inference_without_touching_the_context", async () => {
    const context = new LLMContext();
    context.setMessages([{ role: "system", content: "Be brief." }]);

    const [down] = await runTest(aggregator(context), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("book a flight"),
        new SleepFrame(),
      ],
    });

    // Inference ran against a provisional copy carrying the eager transcript.
    const provisional = ofType(down, LLMContextFrame)[0];
    expect(provisional).toBeDefined();
    expect(provisional!.speculation).toBe(true);
    expect(provisional!.context).not.toBe(context);
    expect(provisional!.context.messages.at(-1)).toEqual({
      role: "user",
      content: "book a flight",
    });

    // The real context is untouched: the turn hasn't ended.
    expect(context.messages).toEqual([{ role: "system", content: "Be brief." }]);
  });

  test("test_matching_transcript_ends_the_turn_and_keeps_the_response", async () => {
    const context = new LLMContext();

    const [down] = await runTest(aggregator(context), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("book a flight"),
        new SleepFrame(),
        final("book a flight"),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 1.0 }),
      ],
    });

    const contexts = ofType(down, LLMContextFrame);
    const stops = ofType(down, UserStoppedSpeakingFrame);

    expect(down.some((f) => f instanceof EagerEndOfTurnCancelFrame)).toBe(false);
    // One inference, the speculative one: the confirmed turn is written to
    // the context without answering it a second time.
    expect(contexts.length).toBe(1);
    expect(contexts[0]!.speculation).toBe(true);
    // The turn end is what releases the held response.
    expect(stops.length).toBe(1);
    expect(context.messages).toEqual([{ role: "user", content: "book a flight" }]);
  });

  test("test_differing_transcript_withdraws_the_speculation", async () => {
    const context = new LLMContext();

    const [down] = await runTest(aggregator(context), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("i want to cancel"),
        new SleepFrame(),
        final("i want to cancel, actually reschedule it"),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 1.0 }),
      ],
    });

    const contexts = ofType(down, LLMContextFrame);
    const cancel = ofType(down, EagerEndOfTurnCancelFrame)[0];

    // The speculative inference, then a second one on the committed transcript.
    expect(contexts.map((c) => c.speculation)).toEqual([true, false]);
    expect(cancel).toBeInstanceOf(EagerEndOfTurnCancelFrame);
    expect(contexts[1]!.context.messages.at(-1)).toEqual({
      role: "user",
      content: "i want to cancel, actually reschedule it",
    });
    // The turn end confirms nothing, so it releases nothing.
    expect(down.some((f) => f instanceof UserStoppedSpeakingFrame)).toBe(true);

    // Only the committed transcript reaches the context.
    expect(context.messages).toEqual([
      { role: "user", content: "i want to cancel, actually reschedule it" },
    ]);
  });

  test("test_resuming_the_turn_withdraws_the_speculation", async () => {
    const context = new LLMContext();

    const [down] = await runTest(aggregator(context), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("i think"),
        new SleepFrame(),
        // The service withdraws the prediction it made.
        new EagerEndOfTurnCancelFrame(),
        new SleepFrame(),
        final("i think i'll book it tomorrow"),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 1.0 }),
      ],
    });

    const contexts = ofType(down, LLMContextFrame);
    const cancels = ofType(down, EagerEndOfTurnCancelFrame);

    // The service's withdrawal travels on its own; the strategy adds none of
    // its own, since the prediction was already withdrawn.
    expect(cancels.length).toBe(1);
    expect(contexts[0]!.speculation).toBe(true);
    expect(contexts[1]!.speculation).toBe(false);
    expect(context.messages).toEqual([{ role: "user", content: "i think i'll book it tomorrow" }]);
  });

  test("test_formatting_differences_are_tolerated_by_default", async () => {
    const context = new LLMContext();

    const [down] = await runTest(aggregator(context), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("book a flight to tokyo"),
        new SleepFrame(),
        // The service formats the transcript it commits; the response
        // still answers the same turn.
        final("Book a flight to Tokyo."),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 1.0 }),
      ],
    });

    const contexts = ofType(down, LLMContextFrame);

    expect(down.some((f) => f instanceof EagerEndOfTurnCancelFrame)).toBe(false);
    expect(contexts.length).toBe(1);
    // The eager transcript drove the response; the committed one is what the
    // context records.
    expect(contexts[0]!.context.messages.at(-1)).toEqual({
      role: "user",
      content: "book a flight to tokyo",
    });
    expect(context.messages).toEqual([{ role: "user", content: "Book a flight to Tokyo." }]);
  });

  test("test_turn_without_an_eager_prediction_behaves_normally", async () => {
    const context = new LLMContext();

    const [down] = await runTest(aggregator(context), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        final("hello there"),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 1.0 }),
      ],
    });

    const contexts = ofType(down, LLMContextFrame);

    expect(down.some((f) => f instanceof EagerEndOfTurnCancelFrame)).toBe(false);
    expect(contexts.length).toBe(1);
    expect(contexts[0]!.speculation).toBe(false);
    expect(down.some((f) => f instanceof UserStoppedSpeakingFrame)).toBe(true);
    expect(context.messages).toEqual([{ role: "user", content: "hello there" }]);
  });

  test("test_eager_transcript_is_not_pushed_downstream", async () => {
    // It is a TextFrame, so anything downstream that speaks or aggregates
    // text must never see it.
    const context = new LLMContext();

    const [down] = await runTest(new Pipeline([aggregator(context)]), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("book a flight"),
        new SleepFrame(),
      ],
    });

    expect(down.some((f) => f instanceof EagerTranscriptionFrame)).toBe(false);
  });
});

/** LLM service that answers every context frame with a tool call. */
class SpeculativeToolCallLLM extends LLMService {
  constructor(options: LLMServiceOptions = {}) {
    super({ ...options, settings: new LLMSettings({ model: "test-model" }) });
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof LLMContextFrame) {
      await this.runFunctionCalls([
        new FunctionCallFromLLM({
          functionName: "book_flight",
          toolCallId: "call-1",
          arguments: {},
          context: frame.context,
        }),
      ]);
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

describe("TestSpeculativeToolCalls", () => {
  test("test_speculative_inference_does_not_execute_tools", async () => {
    // Tools run inside the service, so a discarded speculation could not
    // undo them. They must not run until the turn is committed.
    const calls: FunctionCallParams[] = [];

    const llm = new SpeculativeToolCallLLM();
    llm.registerFunction("book_flight", async (params) => {
      calls.push(params);
    });

    const context = new LLMContext({ messages: [{ role: "user", content: "book a flight" }] });
    const speculative = new LLMContextFrame({ context, speculation: true });

    const [down, up] = await runTest(llm, { framesToSend: [speculative, new SleepFrame()] });

    expect(calls).toEqual([]);
    const withdrawals = ofType([...down, ...up], EagerEndOfTurnCancelFrame);
    expect(withdrawals.length).toBe(2);
  });

  test("test_committed_inference_executes_tools", async () => {
    const calls: FunctionCallParams[] = [];

    const llm = new SpeculativeToolCallLLM();
    llm.registerFunction("book_flight", async (params) => {
      calls.push(params);
    });

    const context = new LLMContext({ messages: [{ role: "user", content: "book a flight" }] });

    const [down, up] = await runTest(llm, {
      framesToSend: [new LLMContextFrame({ context }), new SleepFrame({ sleep: 0.5 })],
    });

    expect(calls.length).toBe(1);
    expect([...down, ...up].some((f) => f instanceof EagerEndOfTurnCancelFrame)).toBe(false);
  });
});

describe("TestUnresolvedSpeculation", () => {
  test("test_new_turn_withdraws_a_speculation_left_in_flight", async () => {
    // A turn boundary the service didn't resolve — a fresh turn starting
    // over a live prediction — still has to withdraw it, or the gate would
    // hold the response until its buffer times out.
    const withdrawals: unknown[] = [];

    const strategy = new EagerUserTurnStopStrategy();
    await strategy.setup(frameProcessorSetup(new TaskManager()));
    strategy.addEventHandler("on_user_turn_speculation_cancelled", (s) => {
      withdrawals.push(s);
    });

    await strategy.processFrame(eager("book a flight"));
    await strategy.handleUserTurnStarted();

    expect(withdrawals.length).toBe(1);

    // The withdrawal happens once: a second boundary has nothing left to
    // withdraw.
    await strategy.handleUserTurnStopped();
    expect(withdrawals.length).toBe(1);
  });
});

describe("TestTurnCommittedWithoutATranscript", () => {
  test("test_speculation_is_withdrawn_when_there_is_nothing_to_compare", async () => {
    // A service can commit an end of turn without a transcript — Flux drops
    // one below `min_confidence`, Cartesia sends `turn.end` with an empty
    // transcript for a turn that captured only noise. The eager prediction
    // had a transcript, but there is nothing to check it against, so the
    // response it produced is discarded rather than spoken.
    const context = new LLMContext();

    // Without recovery for the empty turn, which would write to the context.
    const userAggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new EagerUserTurnStrategies(),
        userTurnStopTimeout: 0.3,
        emptyUserTurn: null,
      }),
    });
    const [down] = await runTest(userAggregator, {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("book a flight"),
        new SleepFrame(),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.8 }),
      ],
    });

    const contexts = ofType(down, LLMContextFrame);
    const cancels = ofType(down, EagerEndOfTurnCancelFrame);

    // Only the speculative inference ran, and it was withdrawn.
    expect(contexts.map((c) => c.speculation)).toEqual([true]);
    expect(cancels.length).toBe(1);
    // The turn end confirms nothing, so the gate would release nothing even
    // if it saw the turn end before the withdrawal.
    expect(down.some((f) => f instanceof UserStoppedSpeakingFrame)).toBe(true);
    // The eager transcript is never written: only a committed one is.
    expect(context.messages).toEqual([]);
  });
});

describe("TestDeferredEagerStrategy", () => {
  test("test_deferring_carries_the_speculation_to_the_subscriber", async () => {
    // The wrapper is transparent apart from the event it suppresses, so the
    // speculation reaches the subscriber on the event that starts it.
    const triggered: UserTurnSpeculation[] = [];

    const inner = new EagerUserTurnStopStrategy();
    await inner.setup(frameProcessorSetup(new TaskManager()));
    const wrapper = deferred(inner);
    wrapper.addEventHandler(
      "on_user_turn_inference_triggered",
      (_strategy, speculation: UserTurnSpeculation) => {
        triggered.push(speculation);
      },
    );

    await wrapper.processFrame(eager("book a flight"));

    expect(triggered.map((s) => s.text)).toEqual(["book a flight"]);
  });
});

describe("TestExactMatchPolicy", () => {
  test("test_formatting_differences_withdraw_the_speculation", async () => {
    // Opting into ExactMatch requires the committed transcript to be
    // identical, so a service that formats what it commits discards the
    // response it had already generated.
    const context = new LLMContext();

    const [down] = await runTest(aggregator(context, { matchPolicy: new ExactMatch() }), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("book a flight to tokyo"),
        new SleepFrame(),
        final("Book a flight to Tokyo."),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 1.0 }),
      ],
    });

    const cancels = ofType(down, EagerEndOfTurnCancelFrame);
    expect(cancels.length).toBe(1);
    expect(context.messages).toEqual([{ role: "user", content: "Book a flight to Tokyo." }]);
  });
});

/** LLM service that answers every context frame with one text response. */
class SpeculativeLLM extends LLMService {
  constructor(options: LLMServiceOptions = {}) {
    super({ ...options, settings: new LLMSettings({ model: "test-model" }) });
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (!(frame instanceof LLMContextFrame)) {
      await this.pushFrame(frame, direction);
      return;
    }

    await this.pushFrame(new LLMFullResponseStartFrame());
    await this.pushFrame(new LLMTextFrame({ text: "Booking your flight." }));
    await this.pushFrame(new LLMFullResponseEndFrame());
  }
}

/** The LLM service holds a speculative response until its turn is confirmed. */
describe("TestLLMServiceHoldsTheSpeculation", () => {
  /** The response frames among everything the service pushed. */
  const responseFrames = (frames: readonly Frame[]): Frame[] =>
    frames.filter(
      (f) =>
        f instanceof LLMFullResponseStartFrame ||
        f instanceof LLMTextFrame ||
        f instanceof LLMFullResponseEndFrame,
    );

  const contextFrame = (speculation = false): LLMContextFrame => {
    const context = new LLMContext({ messages: [{ role: "user", content: "book a flight" }] });
    return new LLMContextFrame({ context, speculation });
  };

  test("test_a_speculative_response_leaves_the_service_only_once_confirmed", async () => {
    const [down] = await runTest(new SpeculativeLLM(), {
      framesToSend: [
        contextFrame(true),
        new SleepFrame(),
        new UserStoppedSpeakingFrame(),
        new SleepFrame(),
      ],
    });

    // The whole response, and only after the frame that confirmed it.
    expect(responseFrames(down).map((f) => f.constructor)).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
    const confirmedAt = down.findIndex((f) => f instanceof UserStoppedSpeakingFrame);
    const responseAt = down.findIndex((f) => f instanceof LLMFullResponseStartFrame);
    expect(confirmedAt).toBeGreaterThanOrEqual(0);
    expect(responseAt).toBeGreaterThanOrEqual(0);
    expect(responseAt).toBeGreaterThan(confirmedAt);
  });

  test("test_a_withdrawn_speculative_response_never_leaves_the_service", async () => {
    const [down] = await runTest(new SpeculativeLLM(), {
      framesToSend: [
        contextFrame(true),
        new SleepFrame(),
        new EagerEndOfTurnCancelFrame(),
        new SleepFrame(),
      ],
    });

    expect(responseFrames(down)).toEqual([]);
  });

  test("test_an_ordinary_response_is_not_held", async () => {
    const [down] = await runTest(new SpeculativeLLM(), {
      framesToSend: [contextFrame(), new SleepFrame()],
    });

    expect(responseFrames(down).map((f) => f.constructor)).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
  });
});

/**
 * A hold that runs out must not cost the turn its reply.
 *
 * The bound exists so the bot is never left silent; giving up on the held
 * response has to put the turn back on the ordinary path rather than leave the
 * strategy waiting for a response the gate has already dropped.
 */
describe("TestATurnOutlastingTheHoldIsStillAnswered", () => {
  const aggregatorAndLlm = (
    speculationTimeout: number,
  ): [LLMContext, LLMUserAggregator, SpeculativeLLM] => {
    const context = new LLMContext();
    return [context, aggregator(context, { speculationTimeout }), new SpeculativeLLM()];
  };

  test("test_a_matching_commit_after_the_hold_expires_runs_a_fresh_inference", async () => {
    const [context, userAggregator, llm] = aggregatorAndLlm(0.2);

    const [down] = await runTest(new Pipeline([userAggregator, llm]), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("book a flight"),
        // Longer than the hold, so the gate gives up before the commit.
        new SleepFrame({ sleep: 0.8 }),
        final("Book a flight."),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.8 }),
      ],
    });

    // The turn is answered, and the context records the committed
    // transcript once rather than an unanswered user message.
    expect(ofType(down, LLMTextFrame).map((f) => f.text)).toEqual(["Booking your flight."]);
    expect(context.messages).toEqual([{ role: "user", content: "Book a flight." }]);
    // Withdrawn where every other discard is withdrawn, so the gate drops
    // the held response rather than relying on a later one to supersede it.
    expect(ofType(down, EagerEndOfTurnCancelFrame).length).toBe(1);
  });

  test("test_a_hold_that_does_not_expire_is_released_as_before", async () => {
    const [, userAggregator, llm] = aggregatorAndLlm(5.0);

    const [down] = await runTest(new Pipeline([userAggregator, llm]), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("book a flight"),
        new SleepFrame(),
        final("Book a flight."),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.8 }),
      ],
    });

    expect(ofType(down, LLMTextFrame).map((f) => f.text)).toEqual(["Booking your flight."]);
  });
});

/** Answers with whatever transcript it was handed, so stale answers are visible. */
class EchoLLM extends LLMService {
  constructor(options: LLMServiceOptions = {}) {
    super({ ...options, settings: new LLMSettings({ model: "test-model" }) });
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (!(frame instanceof LLMContextFrame)) {
      await this.pushFrame(frame, direction);
      return;
    }

    const last = frame.context.messages.at(-1) as { content: unknown };
    await this.pushFrame(new LLMFullResponseStartFrame());
    await this.pushFrame(new LLMTextFrame({ text: `ANSWER[${last.content}]` }));
    await this.pushFrame(new LLMFullResponseEndFrame());
  }
}

/**
 * A withdrawal has to reach the gate before the turn end that follows it.
 *
 * Both travel from the strategy to the same gate. If the withdrawal took a
 * slower route it would arrive second, and the turn end would release the very
 * response the withdrawal was meant to discard.
 */
describe("TestAWithdrawnResponseIsNeverSpoken", () => {
  test("test_a_mismatched_transcript_never_speaks_the_prediction", async () => {
    const context = new LLMContext();

    const [down] = await runTest(new Pipeline([aggregator(context), new EchoLLM()]), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        eager("i want to cancel"),
        new SleepFrame(),
        // The user carried on, so the committed transcript differs.
        final("i want to cancel, actually reschedule it"),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.8 }),
      ],
    });

    // Only the committed transcript is answered — not the sentence the user
    // abandoned, and not both.
    expect(ofType(down, LLMTextFrame).map((f) => f.text)).toEqual([
      "ANSWER[i want to cancel, actually reschedule it]",
    ]);

    const order = down
      .filter(
        (f) => f instanceof EagerEndOfTurnCancelFrame || f instanceof UserStoppedSpeakingFrame,
      )
      .map((f) => f.constructor.name);
    expect(order).toEqual(["EagerEndOfTurnCancelFrame", "UserStoppedSpeakingFrame"]);
  });
});

/**
 * LLM service whose completion streams for a while before calling a tool.
 *
 * Models the window the feature exists to exploit: the committed end of turn
 * can land while the response is still being generated, before the call the
 * response ends up making.
 */
class StreamingToolCallLLM extends LLMService {
  _streamFor: number;
  calls: string[] = [];

  constructor(options: LLMServiceOptions & { streamFor: number }) {
    const { streamFor, ...rest } = options;
    super({ ...rest, settings: new LLMSettings({ model: "test-model" }) });
    this._streamFor = streamFor;
    this.registerFunction("book_flight", async (params) => {
      this.calls.push(params.toolCallId);
    });
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (!(frame instanceof LLMContextFrame)) {
      await this.pushFrame(frame, direction);
      return;
    }

    await this.pushFrame(new LLMFullResponseStartFrame());
    await this.pushFrame(new LLMTextFrame({ text: "Let me check that." }));
    // The turn can be confirmed anywhere in here.
    await sleep(this._streamFor);
    await this.runFunctionCalls([
      new FunctionCallFromLLM({
        functionName: "book_flight",
        toolCallId: "call-1",
        arguments: {},
        context: frame.context,
      }),
    ]);
    await this.pushFrame(new LLMFullResponseEndFrame());
  }
}

/** A tool call is speculative only until the turn it answers is confirmed. */
describe("TestToolCallsAcrossTheConfirmation", () => {
  const contextFrame = (speculation = false): LLMContextFrame => {
    const context = new LLMContext({ messages: [{ role: "user", content: "book a flight" }] });
    return new LLMContextFrame({ context, speculation });
  };

  const withdrawals = (down: Frame[], up: Frame[]): Frame[] =>
    ofType([...down, ...up], EagerEndOfTurnCancelFrame);

  test("test_a_turn_confirmed_mid_stream_lets_the_call_run", async () => {
    // The committed end of turn arrives while the response is still
    // generating, so by the time it reaches its tool call the response is
    // confirmed and the call is an ordinary one.
    const llm = new StreamingToolCallLLM({ streamFor: 0.4 });

    const [down, up] = await runTest(llm, {
      framesToSend: [
        contextFrame(true),
        new SleepFrame({ sleep: 0.15 }),
        new UserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 1.0 }),
      ],
    });

    expect(llm.calls).toEqual(["call-1"]);
    // The released response survives: nothing withdraws it, which is what
    // used to leave the bot speaking a preamble and then falling silent.
    expect(ofType(down, LLMTextFrame).map((f) => f.text)).toEqual(["Let me check that."]);
    expect(withdrawals(down, up)).toEqual([]);
  });

  test("test_a_confirmation_that_overtakes_the_inference_lets_the_call_run", async () => {
    // The confirmation is a system frame, so it can pass the context frame
    // that starts the inference it confirms.
    const llm = new StreamingToolCallLLM({ streamFor: 0.1 });

    const [down, up] = await runTest(llm, {
      framesToSend: [
        new UserStoppedSpeakingFrame(),
        new SleepFrame(),
        contextFrame(true),
        new SleepFrame({ sleep: 0.5 }),
      ],
    });

    expect(llm.calls).toEqual(["call-1"]);
    expect(withdrawals(down, up)).toEqual([]);
  });

  test("test_a_call_reached_before_the_turn_ends_is_withdrawn", async () => {
    // Still speculative: the tool must not run, and the withdrawal names the
    // speculation so the strategy re-runs on the committed transcript.
    const llm = new StreamingToolCallLLM({ streamFor: 0.05 });

    const [down, up] = await runTest(llm, {
      framesToSend: [contextFrame(true), new SleepFrame({ sleep: 0.8 })],
    });

    expect(llm.calls).toEqual([]);
    expect(withdrawals(down, up).length).toBe(2);
  });

  test("test_an_ordinary_inference_calls_its_tool", async () => {
    const llm = new StreamingToolCallLLM({ streamFor: 0.05 });

    const [down, up] = await runTest(llm, {
      framesToSend: [contextFrame(), new SleepFrame({ sleep: 0.8 })],
    });

    expect(llm.calls).toEqual(["call-1"]);
    expect(withdrawals(down, up)).toEqual([]);
  });
});
