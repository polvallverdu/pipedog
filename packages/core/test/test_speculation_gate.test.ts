// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_speculation_gate.py

import { describe, expect, mock, test } from "bun:test";
import {
  EagerEndOfTurnCancelFrame,
  EagerTranscriptionFrame,
  EndFrame,
  type Frame,
  FunctionCallResultFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  UserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { LLMContext } from "../src/processors/aggregators/llm_context.ts";
import {
  LLMUserAggregator,
  LLMUserAggregatorParams,
} from "../src/processors/aggregators/llm_response_universal.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { LLMService, type LLMServiceOptions } from "../src/services/llm_service.ts";
import { LLMSettings } from "../src/services/settings.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { BaseOutputTransport } from "../src/transports/base_output.ts";
import { TransportParams } from "../src/transports/base_transport.ts";
import { SpeculationGate, SpeculationState } from "../src/turns/speculation_gate.ts";
import { ExactMatch, NormalizedMatch } from "../src/turns/user_stop/index.ts";
import { EagerUserTurnStrategies } from "../src/turns/user_turn_strategies.ts";

const DOWN = FrameDirection.DOWNSTREAM;

/** Build the frames of one LLM response. */
function response(texts: string[], options: { end?: boolean } = {}): Frame[] {
  const end = options.end ?? true;
  const frames: Frame[] = [
    new LLMFullResponseStartFrame(),
    ...texts.map((t) => new LLMTextFrame({ text: t })),
  ];
  if (end) {
    frames.push(new LLMFullResponseEndFrame());
  }
  return frames;
}

function toolResult(value = "booked"): FunctionCallResultFrame {
  return new FunctionCallResultFrame({
    functionName: "book_flight",
    toolCallId: "call-1",
    arguments: {},
    result: value,
  });
}

/**
 * Run an inference through the gate the way a host does.
 *
 * The gate is told whether the inference is speculative before its frames
 * arrive, which is what decides whether the response is held.
 */
function speculate(
  gate: SpeculationGate,
  speculation: boolean,
  texts: string[],
  options: { end?: boolean; thenFrames?: Frame[] } = {},
): Frame[] {
  gate.beginSpeculation(speculation);
  return emit(gate, ...response(texts, { end: options.end }), ...(options.thenFrames ?? []));
}

/** Send frames through the gate, collecting everything it lets out. */
function emit(gate: SpeculationGate, ...frames: Frame[]): Frame[] {
  const emitted: Frame[] = [];
  for (const frame of frames) {
    for (const [f] of gate.process(frame, DOWN)) {
      emitted.push(f);
    }
  }
  return emitted;
}

function types(frames: Frame[]): unknown[] {
  return frames.map((f) => f.constructor);
}

function texts(frames: Frame[]): string[] {
  return frames.filter((f) => f instanceof LLMTextFrame).map((f) => (f as LLMTextFrame).text);
}

describe("TestSpeculationGate", () => {
  test("test_non_speculative_response_passes_through", async () => {
    const gate = new SpeculationGate();

    expect(types(speculate(gate, false, ["Hello."]))).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
  });

  test("test_speculative_response_is_held_until_the_turn_ends", async () => {
    const gate = new SpeculationGate();

    expect(speculate(gate, true, ["Booking ", "your flight."])).toEqual([]);
    expect(gate.state).toBe(SpeculationState.HOLDING);

    // Confirmed: the whole response follows, in the order it was generated.
    const released = emit(gate, new UserStoppedSpeakingFrame());
    expect(types(released)).toEqual([
      UserStoppedSpeakingFrame,
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
    expect(texts(released)).toEqual(["Booking ", "your flight."]);
    expect(gate.state).toBe(SpeculationState.OPEN);
  });

  test("test_withdrawn_speculation_is_discarded", async () => {
    const gate = new SpeculationGate();

    expect(speculate(gate, true, ["Cancelling ", "your booking."], { end: false })).toEqual([]);
    expect(types(emit(gate, new EagerEndOfTurnCancelFrame()))).toEqual([EagerEndOfTurnCancelFrame]);

    // Straggling frames of the withdrawn response, still queued behind the
    // cancellation, which overtook them.
    expect(emit(gate, new LLMTextFrame({ text: " Done." }))).toEqual([]);
    expect(types(speculate(gate, false, ["Rescheduling instead."]))).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
  });

  test("test_withdrawal_arriving_before_the_response_it_cancels", async () => {
    // A cancellation is a system frame, so it can overtake the response
    // frames it withdraws.
    const gate = new SpeculationGate();

    expect(types(emit(gate, new EagerEndOfTurnCancelFrame()))).toEqual([EagerEndOfTurnCancelFrame]);
    expect(speculate(gate, true, ["Cancelling."])).toEqual([]);
    expect(types(speculate(gate, false, ["Rescheduling instead."]))).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
  });

  test("test_synthesized_audio_is_held_with_the_response", async () => {
    // A host that gates after synthesis holds the audio too.
    const gate = new SpeculationGate();
    const audio = new TTSAudioRawFrame({
      audio: new Uint8Array([0x00, 0x00]),
      sampleRate: 16000,
      numChannels: 1,
    });

    expect(speculate(gate, true, ["Hi."], { end: false, thenFrames: [audio] })).toEqual([]);
    expect(types(emit(gate, new EagerEndOfTurnCancelFrame()))).toEqual([EagerEndOfTurnCancelFrame]);
  });

  test("test_interruption_discards_the_speculation", async () => {
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false });
    expect(types(emit(gate, new InterruptionFrame()))).toEqual([InterruptionFrame]);
  });

  test("test_upstream_frames_are_never_held", async () => {
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false });
    const upstream = new LLMTextFrame({ text: "upstream" });
    expect(gate.process(upstream, FrameDirection.UPSTREAM)).toEqual([
      [upstream, FrameDirection.UPSTREAM],
    ]);
  });

  test("test_shutdown_delivers_what_has_to_outlive_the_speculation", async () => {
    // EndFrame is uninterruptible and awaited by the runner, so holding it
    // would hang shutdown.
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false, thenFrames: [toolResult()] });
    expect(types(emit(gate, new EndFrame()))).toEqual([FunctionCallResultFrame, EndFrame]);
  });
});

/**
 * What the gate reports about the inference in flight.
 *
 * A host asks this rather than tracking it alongside, so it has to hold up
 * however the turn and the inference are ordered.
 */
describe("TestPendingSpeculation", () => {
  test("test_an_ordinary_inference_is_never_pending", async () => {
    const gate = new SpeculationGate();
    // Upstream passes None (falsy) for an ordinary inference.
    gate.beginSpeculation(null as unknown as boolean);

    expect(gate.isSpeculating).toBeFalsy();
  });

  test("test_it_names_the_inference_until_the_turn_is_confirmed", async () => {
    const gate = new SpeculationGate();
    expect(gate.isSpeculating).toBeFalsy();

    speculate(gate, true, ["Booking."], { end: false });
    expect(gate.isSpeculating).toBeTruthy();

    emit(gate, new UserStoppedSpeakingFrame());
    expect(gate.isSpeculating).toBeFalsy();
  });

  test("test_a_turn_confirmed_mid_inference_clears_it_before_the_response_ends", async () => {
    // The window the feature exists to exploit: the turn is confirmed while
    // the inference is still generating, so what it does next is committed.
    const gate = new SpeculationGate();

    // Upstream passes a truthy string ("abc").
    gate.beginSpeculation("abc" as unknown as boolean);
    emit(gate, response(["Let me check."], { end: false })[0]!);
    emit(gate, new UserStoppedSpeakingFrame());

    expect(gate.isSpeculating).toBeFalsy();
  });

  test("test_a_turn_confirmed_before_the_inference_is_never_pending", async () => {
    // The confirmation is a system frame and can pass the context frame that
    // starts the inference it confirms.
    const gate = new SpeculationGate();

    emit(gate, new UserStoppedSpeakingFrame());
    gate.beginSpeculation("abc" as unknown as boolean);

    expect(gate.isSpeculating).toBeFalsy();
    // And nothing is held back, since the turn it answers is already over.
    expect(types(emit(gate, ...response(["Booking."])))).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
  });

  test("test_a_withdrawal_clears_it", async () => {
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false });
    emit(gate, new EagerEndOfTurnCancelFrame());

    expect(gate.isSpeculating).toBeFalsy();
  });

  test("test_an_interruption_clears_it", async () => {
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false });
    emit(gate, new InterruptionFrame());

    expect(gate.isSpeculating).toBeFalsy();
  });

  test("test_a_superseding_inference_keeps_its_own", async () => {
    // Dropping the held response ends that hold, but the inference that
    // replaced it is pending and must stay so.
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false });
    speculate(gate, true, ["Rescheduling."], { end: false });

    expect(gate.isSpeculating).toBeTruthy();
  });
});

describe("TestEagerMatchPolicies", () => {
  test("test_exact_match", async () => {
    const policy = new ExactMatch();
    expect(policy.matches("book a flight", "book a flight")).toBeTruthy();
    expect(policy.matches("book a flight", "Book a flight.")).toBeFalsy();
    expect(policy.matches("book a flight", "book a flight tomorrow")).toBeFalsy();
  });

  test("test_normalized_match", async () => {
    const policy = new NormalizedMatch();
    expect(policy.matches("book a flight", "Book a flight.")).toBeTruthy();
    expect(policy.matches("book  a flight", "book a flight")).toBeTruthy();
    expect(policy.matches("its ready", "It's ready!")).toBeTruthy();
    expect(policy.matches("book a flight", "book a flight tomorrow")).toBeFalsy();
    expect(policy.matches("i want to cancel", "I want to reschedule.")).toBeFalsy();
  });
});

describe("TestSpeculationGateOrdering", () => {
  test("test_a_withdrawn_response_is_not_released_by_the_turn_ending", async () => {
    // The mismatch path withdraws before it ends the turn, so by the time
    // the turn ends there is nothing left to release. The gate relies on
    // that order: a turn ending releases whatever it is still holding.
    const gate = new SpeculationGate();

    speculate(gate, true, ["Cancelling."], { end: false });
    expect(types(emit(gate, new EagerEndOfTurnCancelFrame()))).toEqual([EagerEndOfTurnCancelFrame]);
    expect(types(emit(gate, new UserStoppedSpeakingFrame()))).toEqual([UserStoppedSpeakingFrame]);
  });

  test("test_confirmation_arriving_before_the_response", async () => {
    const gate = new SpeculationGate();

    expect(types(emit(gate, new UserStoppedSpeakingFrame()))).toEqual([UserStoppedSpeakingFrame]);
    expect(types(speculate(gate, true, ["Booking."]))).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
  });
});

describe("TestSupersededSpeculation", () => {
  test("test_a_new_response_supersedes_a_held_one", async () => {
    // A withdrawal that arrives before the response it voids needs no
    // memory: the response is held on arrival, and whatever answers the
    // turn instead supersedes it.
    const gate = new SpeculationGate();

    emit(gate, new EagerEndOfTurnCancelFrame());
    expect(speculate(gate, true, ["Cancelling."], { end: false })).toEqual([]);
    expect(types(speculate(gate, false, ["Rescheduling instead."]))).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
    expect(gate.state).toBe(SpeculationState.OPEN);
  });

  test("test_a_held_response_does_not_swallow_the_one_that_supersedes_it", async () => {
    // The held response never ends: its generation was cancelled mid-flight,
    // so no end frame is coming and only a new response resolves it. Its
    // frames are dropped, but the response that supersedes it has to pass
    // through whole — nothing of the held one can still be queued behind a
    // frame that arrived after it.
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false });
    const emitted = speculate(gate, false, ["Something else entirely."]);

    expect(types(emitted)).toEqual([
      LLMFullResponseStartFrame,
      LLMTextFrame,
      LLMFullResponseEndFrame,
    ]);
    expect(texts(emitted)).toEqual(["Something else entirely."]);
  });
});

describe("TestUninterruptibleFrames", () => {
  test("test_a_tool_result_survives_a_discarded_speculation", async () => {
    // An async tool started in an earlier turn can return while a
    // speculation is held. Its result belongs to that earlier work and is
    // guaranteed delivery, so discarding the speculation around it keeps it.
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false, thenFrames: [toolResult()] });
    const emitted = emit(gate, new EagerEndOfTurnCancelFrame());

    expect(types(emitted)).toEqual([EagerEndOfTurnCancelFrame, FunctionCallResultFrame]);
    expect(
      emitted
        .filter((f) => f instanceof FunctionCallResultFrame)
        .map((f) => (f as FunctionCallResultFrame).result),
    ).toEqual(["booked"]);
  });

  test("test_a_tool_result_is_held_in_order_with_the_response", async () => {
    // Uninterruptible frames are ordered like any other, so one that arrives
    // mid-response is released in the position it arrived in.
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false, thenFrames: [toolResult()] });
    expect(types(emit(gate, new UserStoppedSpeakingFrame()))).toEqual([
      UserStoppedSpeakingFrame,
      LLMFullResponseStartFrame,
      LLMTextFrame,
      FunctionCallResultFrame,
    ]);
  });

  test("test_a_tool_result_is_not_dropped_with_a_response_being_dropped", async () => {
    // Nothing is held back while dropping a withdrawn response's tail, so an
    // uninterruptible frame passes on in order rather than being dropped.
    const gate = new SpeculationGate();

    speculate(gate, true, ["Booking."], { end: false });
    expect(types(emit(gate, new EagerEndOfTurnCancelFrame()))).toEqual([EagerEndOfTurnCancelFrame]);
    // Still queued behind the withdrawal, which overtook it.
    expect(types(emit(gate, new LLMTextFrame({ text: " Done." }), toolResult()))).toEqual([
      FunctionCallResultFrame,
    ]);
  });
});

/** Answers every context frame, gating what it pushes as `LLMService` does. */
class GatedLLM extends LLMService {
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

describe("TestGatedPipeline", () => {
  test("test_the_transport_sees_a_response_only_once_it_is_confirmed", async () => {
    // The whole path: aggregator, gating LLM, output transport. Nothing the
    // speculation produced reaches the transport before the turn ends, and
    // the context records the committed transcript rather than the eager one.
    const context = new LLMContext();
    const aggregator = new LLMUserAggregator(context, {
      params: new LLMUserAggregatorParams({
        userTurnStrategies: new EagerUserTurnStrategies(),
      }),
    });
    const transport = new BaseOutputTransport(new TransportParams());
    const handleFrame = mock(async (_frame: Frame) => {});
    // Python replaces the protected `_handle_frame` with an AsyncMock.
    (transport as unknown as { _handleFrame: typeof handleFrame })._handleFrame = handleFrame;

    await runTest(new Pipeline([aggregator, new GatedLLM(), transport]), {
      framesToSend: [
        new ProposedUserStartedSpeakingFrame(),
        new SleepFrame(),
        new EagerTranscriptionFrame({ text: "book a flight", userId: "user", timestamp: "t" }),
        new SleepFrame(),
        new TranscriptionFrame({ text: "Book a flight.", userId: "user", timestamp: "t" }),
        new SleepFrame(),
        new ProposedUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 1.0 }),
      ],
    });

    const spoken = handleFrame.mock.calls.map((call) => call[0]);
    expect(texts(spoken)).toEqual(["Booking your flight."]);
    expect(context.messages).toEqual([{ role: "user", content: "Book a flight." }]);
  });
});
