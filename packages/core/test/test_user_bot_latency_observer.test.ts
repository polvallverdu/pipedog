// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_user_bot_latency_observer.py

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { sleep } from "@pipedog/asyncio";

import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  BotStartedSpeakingFrame,
  ClientConnectedFrame,
  type Frame,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  InterruptionFrame,
  LLMFullResponseStartFrame,
  LLMMarkerFrame,
  LLMTextFrame,
  MetricsFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import { TextAggregationMetricsData, TTFBMetricsData } from "../src/metrics/metrics.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import {
  LatencyBreakdown,
  type LatencyBreakdown as LatencyBreakdownType,
  LatencyContribution,
  LatencyOwnerKind,
  MeasuredFrom,
  PRINTS_AS_ZERO_SECS,
  UserBotLatencyObserver,
  type UserBotLatencyObserverOptions,
} from "../src/observers/user_bot_latency_observer.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import {
  FrameDirection,
  FrameProcessor,
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import {
  USER_TURN_COMPLETE_MARKER,
  USER_TURN_INCOMPLETE_SHORT_MARKER,
  UserTurnCompletionLLMServiceMixin,
} from "../src/turns/user_turn_completion_mixin.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";

// Python tests read protected attributes and replace methods on instances.
type Loose = any;

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

/** The smallest processor that runs the turn completion protocol. */
class _MarkerProcessor extends UserTurnCompletionLLMServiceMixin(FrameProcessor) {}

/** `assertAlmostEqual(a, b, delta=d)`. */
function expectWithin(actual: number, expected: number, delta: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(delta);
}

/** Python's `round(x, n)` for the values these tests compare. */
function round(x: number, n: number): number {
  return Number(x.toFixed(n));
}

function ttsAudio(): TTSAudioRawFrame {
  return new TTSAudioRawFrame({ audio: new Uint8Array(0), sampleRate: 24000, numChannels: 1 });
}

describe("TestUserBotLatencyObserver", () => {
  test("test_normal_latency_measurement", async () => {
    // Create observer
    const observer = new UserBotLatencyObserver();

    // Create identity filter (passes all frames through)
    const processor = new IdentityFilter();

    // Capture latency events
    const latencies: number[] = [];
    observer.eventHandler("on_latency_measured", async (_obs, latencySeconds: number) => {
      latencies.push(latencySeconds);
    });

    // Run test
    await runTest(processor, {
      framesToSend: [new VADUserStoppedSpeakingFrame(), new BotStartedSpeakingFrame()],
      expectedDownFrames: [VADUserStoppedSpeakingFrame, BotStartedSpeakingFrame],
      observers: [observer],
    });

    // Verify latency was measured
    expect(latencies.length).toEqual(1);
    expect(latencies[0]).toBeGreaterThan(0);
    expect(latencies[0]).toBeLessThan(1.0); // Should be very quick
  });

  test("test_multiple_latency_measurements", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const latencies: number[] = [];
    observer.eventHandler("on_latency_measured", async (_obs, latencySeconds: number) => {
      latencies.push(latencySeconds);
    });

    await runTest(processor, {
      framesToSend: [
        // First cycle
        new VADUserStoppedSpeakingFrame(),
        new BotStartedSpeakingFrame(),
        // Second cycle
        new VADUserStoppedSpeakingFrame(),
        new BotStartedSpeakingFrame(),
      ],
      expectedDownFrames: [
        VADUserStoppedSpeakingFrame,
        BotStartedSpeakingFrame,
        VADUserStoppedSpeakingFrame,
        BotStartedSpeakingFrame,
      ],
      observers: [observer],
    });

    // Verify two separate latencies were measured
    expect(latencies.length).toEqual(2);
    expect(latencies[0]).toBeGreaterThan(0);
    expect(latencies[1]).toBeGreaterThan(0);
  });

  test("test_breakdown_with_metrics", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const breakdowns: LatencyBreakdownType[] = [];
    observer.eventHandler("on_latency_breakdown", async (_obs, breakdown: LatencyBreakdownType) => {
      breakdowns.push(breakdown);
    });

    const sttTtfb = new TTFBMetricsData({ processor: "DeepgramSTTService#0", value: 0.08 });
    const llmTtfb = new TTFBMetricsData({
      processor: "OpenAILLMService#0",
      model: "gpt-4o",
      value: 0.25,
    });
    const ttsTtfb = new TTFBMetricsData({ processor: "CartesiaTTSService#0", value: 0.07 });
    const textAgg = new TextAggregationMetricsData({
      processor: "CartesiaTTSService#0",
      value: 0.03,
    });

    await runTest(processor, {
      framesToSend: [
        new VADUserStoppedSpeakingFrame(),
        new MetricsFrame({ data: [sttTtfb] }),
        new MetricsFrame({ data: [llmTtfb, textAgg] }),
        new MetricsFrame({ data: [ttsTtfb] }),
        new BotStartedSpeakingFrame(),
      ],
      expectedDownFrames: [
        VADUserStoppedSpeakingFrame,
        MetricsFrame,
        MetricsFrame,
        MetricsFrame,
        BotStartedSpeakingFrame,
      ],
      observers: [observer],
    });

    expect(breakdowns.length).toEqual(1);
    const bd = breakdowns[0]!;
    expect(bd.ttfb.length).toEqual(3);
    expect(bd.ttfb[0]!.processor).toEqual("DeepgramSTTService#0");
    expect(bd.ttfb[1]!.processor).toEqual("OpenAILLMService#0");
    expect(bd.ttfb[2]!.processor).toEqual("CartesiaTTSService#0");
    expect(bd.textAggregation).not.toBeNull();
    expect(bd.textAggregation!.durationSecs).toEqual(0.03);
  });

  test("test_interruption_resets_accumulators", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const breakdowns: LatencyBreakdownType[] = [];
    observer.eventHandler("on_latency_breakdown", async (_obs, breakdown: LatencyBreakdownType) => {
      breakdowns.push(breakdown);
    });

    // First cycle metrics (will be interrupted)
    const staleLlm = new TTFBMetricsData({ processor: "OpenAILLMService#0", value: 0.245 });
    // Second cycle metrics (the ones that matter)
    const finalLlm = new TTFBMetricsData({ processor: "OpenAILLMService#0", value: 0.224 });
    const finalTts = new TTFBMetricsData({ processor: "CartesiaTTSService#0", value: 0.142 });

    await runTest(processor, {
      framesToSend: [
        new VADUserStoppedSpeakingFrame(),
        new MetricsFrame({ data: [staleLlm] }),
        new InterruptionFrame(),
        new MetricsFrame({ data: [finalLlm] }),
        new MetricsFrame({ data: [finalTts] }),
        new BotStartedSpeakingFrame(),
      ],
      expectedDownFrames: [
        VADUserStoppedSpeakingFrame,
        MetricsFrame,
        InterruptionFrame,
        MetricsFrame,
        MetricsFrame,
        BotStartedSpeakingFrame,
      ],
      observers: [observer],
    });

    expect(breakdowns.length).toEqual(1);
    const bd = breakdowns[0]!;
    // Only the post-interruption metrics should be present
    expect(bd.ttfb.length).toEqual(2);
    expect(bd.ttfb[0]!.processor).toEqual("OpenAILLMService#0");
    expect(bd.ttfb[0]!.durationSecs).toEqual(0.224);
    expect(bd.ttfb[1]!.processor).toEqual("CartesiaTTSService#0");
    expect(bd.ttfb[1]!.durationSecs).toEqual(0.142);
  });

  test("test_only_first_text_aggregation_kept", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const breakdowns: LatencyBreakdownType[] = [];
    observer.eventHandler("on_latency_breakdown", async (_obs, breakdown: LatencyBreakdownType) => {
      breakdowns.push(breakdown);
    });

    const textAgg1 = new TextAggregationMetricsData({
      processor: "CartesiaTTSService#0",
      value: 0.03,
    });
    const textAgg2 = new TextAggregationMetricsData({
      processor: "CartesiaTTSService#0",
      value: 0.08,
    });

    await runTest(processor, {
      framesToSend: [
        new VADUserStoppedSpeakingFrame(),
        new MetricsFrame({ data: [textAgg1] }),
        new MetricsFrame({ data: [textAgg2] }),
        new BotStartedSpeakingFrame(),
      ],
      expectedDownFrames: [
        VADUserStoppedSpeakingFrame,
        MetricsFrame,
        MetricsFrame,
        BotStartedSpeakingFrame,
      ],
      observers: [observer],
    });

    expect(breakdowns.length).toEqual(1);
    expect(breakdowns[0]!.textAggregation).not.toBeNull();
    expect(breakdowns[0]!.textAggregation!.durationSecs).toEqual(0.03);
  });

  test("test_user_turn_measured", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const breakdowns: LatencyBreakdownType[] = [];
    observer.eventHandler("on_latency_breakdown", async (_obs, breakdown: LatencyBreakdownType) => {
      breakdowns.push(breakdown);
    });

    await runTest(processor, {
      framesToSend: [
        new VADUserStoppedSpeakingFrame(),
        new SleepFrame({ sleep: 0.2 }), // Simulate turn analyzer wait
        new UserStoppedSpeakingFrame(),
        new BotStartedSpeakingFrame(),
      ],
      expectedDownFrames: [
        VADUserStoppedSpeakingFrame,
        UserStoppedSpeakingFrame,
        BotStartedSpeakingFrame,
      ],
      observers: [observer],
    });

    expect(breakdowns.length).toEqual(1);
    expect(breakdowns[0]!.userTurnSecs).not.toBeNull();
    expect(breakdowns[0]!.userTurnSecs!).toBeGreaterThanOrEqual(0.1);
  });

  test("test_user_turn_none_without_user_stopped", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const breakdowns: LatencyBreakdownType[] = [];
    observer.eventHandler("on_latency_breakdown", async (_obs, breakdown: LatencyBreakdownType) => {
      breakdowns.push(breakdown);
    });

    await runTest(processor, {
      framesToSend: [new VADUserStoppedSpeakingFrame(), new BotStartedSpeakingFrame()],
      expectedDownFrames: [VADUserStoppedSpeakingFrame, BotStartedSpeakingFrame],
      observers: [observer],
    });

    expect(breakdowns.length).toEqual(1);
    expect(breakdowns[0]!.userTurnSecs).toBeNull();
  });

  test("test_no_measurement_without_user_stop", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const latencies: number[] = [];
    const breakdowns: LatencyBreakdownType[] = [];
    observer.eventHandler("on_latency_measured", async (_obs, latencySeconds: number) => {
      latencies.push(latencySeconds);
    });
    observer.eventHandler("on_latency_breakdown", async (_obs, breakdown: LatencyBreakdownType) => {
      breakdowns.push(breakdown);
    });

    await runTest(processor, {
      framesToSend: [new BotStartedSpeakingFrame()],
      expectedDownFrames: [BotStartedSpeakingFrame],
      observers: [observer],
    });

    expect(latencies.length).toEqual(0);
    expect(breakdowns.length).toEqual(0);
  });

  test("test_first_bot_speech_latency", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const firstSpeechLatencies: number[] = [];
    const breakdowns: LatencyBreakdownType[] = [];
    observer.eventHandler("on_first_bot_speech_latency", async (_obs, latencySeconds: number) => {
      firstSpeechLatencies.push(latencySeconds);
    });
    observer.eventHandler("on_latency_breakdown", async (_obs, breakdown: LatencyBreakdownType) => {
      breakdowns.push(breakdown);
    });

    const llmTtfb = new TTFBMetricsData({ processor: "OpenAILLMService#0", value: 0.25 });
    const ttsTtfb = new TTFBMetricsData({ processor: "CartesiaTTSService#0", value: 0.07 });

    await runTest(processor, {
      framesToSend: [
        new ClientConnectedFrame(),
        new MetricsFrame({ data: [llmTtfb] }),
        new MetricsFrame({ data: [ttsTtfb] }),
        new BotStartedSpeakingFrame(),
      ],
      expectedDownFrames: [
        ClientConnectedFrame,
        MetricsFrame,
        MetricsFrame,
        BotStartedSpeakingFrame,
      ],
      observers: [observer],
    });

    expect(firstSpeechLatencies.length).toEqual(1);
    expect(firstSpeechLatencies[0]).toBeGreaterThan(0);
    expect(firstSpeechLatencies[0]).toBeLessThan(1.0);

    // Breakdown should also be emitted with the accumulated metrics
    expect(breakdowns.length).toEqual(1);
    expect(breakdowns[0]!.ttfb.length).toEqual(2);
    expect(breakdowns[0]!.ttfb[0]!.processor).toEqual("OpenAILLMService#0");
    expect(breakdowns[0]!.ttfb[1]!.processor).toEqual("CartesiaTTSService#0");
  });

  test("test_first_bot_speech_only_once", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const firstSpeechLatencies: number[] = [];
    observer.eventHandler("on_first_bot_speech_latency", async (_obs, latencySeconds: number) => {
      firstSpeechLatencies.push(latencySeconds);
    });

    await runTest(processor, {
      framesToSend: [
        new ClientConnectedFrame(),
        new BotStartedSpeakingFrame(),
        // Second bot speech should not trigger the event again
        new VADUserStoppedSpeakingFrame(),
        new BotStartedSpeakingFrame(),
      ],
      expectedDownFrames: [
        ClientConnectedFrame,
        BotStartedSpeakingFrame,
        VADUserStoppedSpeakingFrame,
        BotStartedSpeakingFrame,
      ],
      observers: [observer],
    });

    expect(firstSpeechLatencies.length).toEqual(1);
  });

  test("test_first_bot_speech_skipped_when_user_speaks_first", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const firstSpeechLatencies: number[] = [];
    observer.eventHandler("on_first_bot_speech_latency", async (_obs, latencySeconds: number) => {
      firstSpeechLatencies.push(latencySeconds);
    });

    await runTest(processor, {
      framesToSend: [
        new ClientConnectedFrame(),
        // User speaks before bot has a chance to greet
        new VADUserStartedSpeakingFrame(),
        new VADUserStoppedSpeakingFrame(),
        new BotStartedSpeakingFrame(),
      ],
      expectedDownFrames: [
        ClientConnectedFrame,
        VADUserStartedSpeakingFrame,
        VADUserStoppedSpeakingFrame,
        BotStartedSpeakingFrame,
      ],
      observers: [observer],
    });

    expect(firstSpeechLatencies.length).toEqual(0);
  });

  test("test_function_call_latency_in_breakdown", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const breakdowns: LatencyBreakdownType[] = [];
    observer.eventHandler("on_latency_breakdown", async (_obs, breakdown: LatencyBreakdownType) => {
      breakdowns.push(breakdown);
    });

    const toolCallId = "call_abc123";

    await runTest(processor, {
      framesToSend: [
        new VADUserStoppedSpeakingFrame(),
        new FunctionCallInProgressFrame({
          functionName: "get_weather",
          toolCallId,
          arguments: { location: "Atlanta" },
        }),
        new SleepFrame({ sleep: 0.2 }),
        new FunctionCallResultFrame({
          functionName: "get_weather",
          toolCallId,
          arguments: { location: "Atlanta" },
          result: { temperature: "75" },
        }),
        new BotStartedSpeakingFrame(),
      ],
      observers: [observer],
    });

    expect(breakdowns.length).toEqual(1);
    expect(breakdowns[0]!.functionCalls.length).toEqual(1);
    const fc = breakdowns[0]!.functionCalls[0]!;
    expect(fc.functionName).toEqual("get_weather");
    expect(fc.durationSecs).toBeGreaterThanOrEqual(0.1);
  });

  test("test_function_call_reset_on_interruption", async () => {
    const observer = new UserBotLatencyObserver();
    const processor = new IdentityFilter();

    const breakdowns: LatencyBreakdownType[] = [];
    observer.eventHandler("on_latency_breakdown", async (_obs, breakdown: LatencyBreakdownType) => {
      breakdowns.push(breakdown);
    });

    await runTest(processor, {
      framesToSend: [
        new VADUserStoppedSpeakingFrame(),
        new FunctionCallInProgressFrame({
          functionName: "get_weather",
          toolCallId: "call_1",
          arguments: {},
        }),
        new FunctionCallResultFrame({
          functionName: "get_weather",
          toolCallId: "call_1",
          arguments: {},
          result: {},
        }),
        new InterruptionFrame(),
        new BotStartedSpeakingFrame(),
      ],
      observers: [observer],
    });

    expect(breakdowns.length).toEqual(1);
    expect(breakdowns[0]!.functionCalls.length).toEqual(0);
  });
});

describe("TestLatencyBreakdownChronologicalEvents", () => {
  // `LatencyBreakdown.chronological_events` is deprecated upstream (1.9.0, removed in 2.0.0,
  // replaced by `turn_contribution_lines`) and is not ported, so these tests are skipped.
  test.skip("test_events_sorted_by_start_time", () => {});
  test.skip("test_empty_breakdown", () => {});
  test.skip("test_user_turn_requires_both_fields", () => {});
  test.skip("test_ttfb_only", () => {});
});

/** Drives an observer through a cycle on a clock the test controls. */
class _CycleDriver {
  // A clock the test advances by hand, so a cycle can describe intervals
  // of any length without waiting them out.
  clock = 1_000_000.0;
  observer!: UserBotLatencyObserver;
  breakdowns: LatencyBreakdownType[] = [];
  silenceAt = 0;
  spokeAt = 0;

  async asyncSetUp(): Promise<void> {
    this.clock = 1_000_000.0;
    await this._observe();
  }

  /** Start a fresh observer reading this test's clock. */
  async _observe(options: UserBotLatencyObserverOptions = {}): Promise<void> {
    this.observer = new UserBotLatencyObserver({ timeSource: () => this.clock, ...options });
    // Event handlers run as tasks, so the observer needs a task manager.
    await this.observer.setup(new TaskManager());
    const breakdowns: LatencyBreakdownType[] = [];
    this.breakdowns = breakdowns;

    this.observer.eventHandler(
      "on_latency_breakdown",
      async (_obs, breakdown: LatencyBreakdownType) => {
        breakdowns.push(breakdown);
      },
    );
  }

  /** Advance the clock without sleeping. */
  _wait(seconds: number): void {
    this.clock += seconds;
  }

  /** Feed one frame to the observer, as a pipeline push would. */
  async _push(frame: Frame, source = "source"): Promise<void> {
    await this.observer.onPushFrame(
      new FramePushed({
        source: new IdentityFilter({ name: source }),
        destination: new IdentityFilter({ name: "destination" }),
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: 0,
      }),
    );
  }

  /** Let the event handler task deliver the breakdown. */
  async _settle(): Promise<void> {
    await sleep(0.01);
  }

  get lastBreakdown(): LatencyBreakdownType {
    return this.breakdowns[this.breakdowns.length - 1]!;
  }
}

interface CompleteTurnOptions {
  marker?: boolean;
  hold?: boolean;
  holdSecs?: number;
  detect?: number;
  aggregation?: number;
  buffered?: number;
}

/** Contributions name each part of a cycle and sum to its latency. */
class _ContributionsDriver extends _CycleDriver {
  async _completeTurn(options: CompleteTurnOptions = {}): Promise<LatencyBreakdownType> {
    const marker = options.marker ?? true;
    const hold = options.hold ?? false;
    const holdSecs = options.holdSecs ?? 0.06;
    const detect = options.detect ?? 0.0;
    const aggregation = options.aggregation ?? 0.0;
    const buffered = options.buffered ?? 0.0;

    // The cycle is measured from the silence the VAD waited out.
    this.silenceAt = this.clock - 0.02;
    await this._push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.02, timestamp: this.clock }));
    this._wait(0.02);
    await this._push(new TranscriptionFrame({ userId: "u", text: "hi", timestamp: "" }), "STT#0");
    if (detect) {
      this._wait(detect);
    }
    await this._push(new LLMFullResponseStartFrame(), "LLM#0");
    if (hold) {
      this._wait(0.01);
      await this._push(
        new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.01 })] }),
      );
      await this._push(new LLMMarkerFrame({ marker: "◐" }));
      this._wait(holdSecs);
      await this._push(new LLMFullResponseStartFrame(), "LLM#0");
    }
    this._wait(0.02);
    await this._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.02 })] }),
    );
    if (marker) {
      await this._push(new LLMMarkerFrame({ marker: "●", appendToContextImmediately: false }));
      this._wait(0.02);
    }
    if (buffered) {
      this._wait(buffered);
    }
    await this._push(new LLMTextFrame({ text: "Hi!" }), "LLM#0");
    if (aggregation) {
      this._wait(aggregation);
      await this._push(
        new MetricsFrame({
          data: [new TextAggregationMetricsData({ processor: "TTS#0", value: aggregation })],
        }),
      );
    }
    this._wait(0.02);
    await this._push(ttsAudio(), "TTS#0");
    await this._push(new BotStartedSpeakingFrame(), "Transport#0");
    this.spokeAt = this.clock;
    await sleep(0.01); // let the event handler task run
    return this.lastBreakdown;
  }
}

describe("TestLatencyContributions", () => {
  let self: _ContributionsDriver;

  beforeEach(async () => {
    self = new _ContributionsDriver();
    await self.asyncSetUp();
  });

  test("test_contributions_sum_to_the_measured_latency", async () => {
    // Nothing in the interval goes unnamed.
    const breakdown = await self._completeTurn();
    const total = breakdown.contributions.reduce((s, c) => s + c.durationSecs, 0);
    expect(total).toBeCloseTo(self.spokeAt - self.silenceAt, 6);
  });

  test("test_a_complete_turn_names_each_stage", async () => {
    // A turn the LLM completed has no wait, and lists the rest in order.
    const breakdown = await self._completeTurn();
    const labels = breakdown.contributions.map((c) => c.label);
    expect(labels).toEqual([
      "endpointing wait",
      "transcription",
      "LLM inference",
      "turn completion",
      "speech synthesis",
    ]);
    const endpointing = breakdown.contributions[0]!;
    expect(endpointing.owner).toEqual("config: VAD stop_secs");
    expectWithin(endpointing.durationSecs, 0.02, 0.01);
  });

  test("test_a_held_turn_names_the_wait", async () => {
    // An incomplete marker shows up as a wait, not as slow inference.
    const breakdown = await self._completeTurn({ hold: true });
    const wait = breakdown.contributions.find((c) => c.label === "waiting for user")!;
    expect(wait).toBeDefined();
    expect(wait.owner).toEqual("config: filter_incomplete_user_turns");
    expect(wait.durationSecs).toBeGreaterThan(0.05);
    // Both inferences are listed, so neither absorbs the wait.
    expect(breakdown.contributions.filter((c) => c.label === "LLM inference").length).toEqual(2);
  });

  test("test_a_bot_without_turn_completion_has_no_marker_entry", async () => {
    // Parts that didn't happen aren't listed.
    const breakdown = await self._completeTurn({ marker: false });
    const labels = breakdown.contributions.map((c) => c.label);
    expect(labels).not.toContain("turn completion");
    expect(labels).not.toContain("waiting for user");
    // The wait for a speakable token is the LLM streaming, not a diagnosis.
    expect(labels).not.toContain("awaiting speakable text");
  });

  test("test_a_missing_marker_is_reported_once_markers_are_in_use", async () => {
    // A bot that emits markers, on a response that carried none.
    await self._completeTurn(); // establishes that this bot uses markers
    const breakdown = await self._completeTurn({ marker: false, buffered: 0.05 });
    const buffered = breakdown.contributions.find((c) => c.label === "awaiting speakable text")!;
    expect(buffered).toBeDefined();
    expect(buffered.durationSecs).toBeGreaterThan(0.04);
  });

  test("test_turn_contribution_lines_order_and_total", () => {
    // Chronological by default, largest first by cost, always with a total.
    const breakdown = new LatencyBreakdown({
      contributions: [
        new LatencyContribution({
          key: "endpointing_wait",
          label: "endpointing wait",
          owner: "config: VAD stop_secs",
          ownerKind: LatencyOwnerKind.SETTING,
          startTime: 0.0,
          durationSecs: 0.2,
        }),
        new LatencyContribution({
          key: "speech_synthesis",
          label: "speech synthesis",
          owner: "TTS#0",
          ownerKind: LatencyOwnerKind.SERVICE,
          startTime: 0.2,
          durationSecs: 0.4,
        }),
      ],
    });
    expect(breakdown.turnContributionLines()[0]).toContain("endpointing wait");
    expect(breakdown.turnContributionLines({ byCost: true })[0]).toContain("speech synthesis");
    const lines = breakdown.turnContributionLines();
    expect(lines[lines.length - 1]).toContain("0.600s  TOTAL");
  });

  test("test_turn_completion_covers_the_gate_and_the_marker_token", async () => {
    // The span runs from the LLM's first chunk to the first speakable token.
    const breakdown = await self._completeTurn();
    const completion = breakdown.contributions.find((c) => c.label === "turn completion")!;
    expect(completion).toBeDefined();
    expect(completion.owner).toEqual("config: filter_incomplete_user_turns");
    expect(completion.durationSecs).toBeGreaterThan(0.015);
  });

  test("test_zero_threshold_lists_every_contribution", async () => {
    // Nothing is folded away when the threshold is off.
    self.observer = new UserBotLatencyObserver({ minContributionSecs: 0 });
    await self.observer.setup(new TaskManager());
    const breakdowns: LatencyBreakdownType[] = [];
    self.breakdowns = breakdowns;
    self.observer.eventHandler(
      "on_latency_breakdown",
      async (_obs, breakdown: LatencyBreakdownType) => {
        breakdowns.push(breakdown);
      },
    );

    const breakdown = await self._completeTurn();
    // Every span is listed, so the residual is gone or negligible.
    const pipeline = breakdown.contributions.find((c) => c.label === "pipeline");
    expect(pipeline === undefined || pipeline.durationSecs < 0.01).toBe(true);
    expect(breakdown.contributions.map((c) => c.label)).toContain("output transport");
  });

  test("test_core_stages_are_listed_when_brief_but_measurable", async () => {
    // A stage of a few milliseconds is listed; one that rounds to zero is not.
    let breakdown = await self._completeTurn({ detect: 0.002 });
    const detection = breakdown.contributions.find((c) => c.label === "turn detection")!;
    expect(detection).toBeDefined();
    expect(detection.durationSecs).toBeLessThan(0.005);
    expect(detection.owner).toEqual("config: user turn strategies");

    breakdown = await self._completeTurn();
    expect(breakdown.contributions.map((c) => c.label)).not.toContain("turn detection");
  });

  test("test_sentence_aggregation_is_listed_only_when_it_waits", async () => {
    // Sentence mode reports the wait; token mode reports nothing.
    let breakdown = await self._completeTurn({ aggregation: 0.05 });
    const aggregation = breakdown.contributions.find((c) => c.label === "sentence aggregation")!;
    expect(aggregation).toBeDefined();
    expectWithin(aggregation.durationSecs, 0.05, 0.01);
    expect(aggregation.owner).toEqual("config: text_aggregation_mode");
    const synthesis = breakdown.contributions.find((c) => c.label === "speech synthesis")!;
    expect(synthesis).toBeDefined();
    expect(synthesis.startTime).toBeGreaterThan(aggregation.startTime);

    breakdown = await self._completeTurn({ aggregation: 0 });
    expect(breakdown.contributions.map((c) => c.label)).not.toContain("sentence aggregation");
  });

  test("test_function_handlers_are_listed_with_the_wait_that_precedes_them", async () => {
    // A tool turn names both writing the call and running the handler.
    await self._push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.02, timestamp: self.clock }));
    await self._push(
      new TranscriptionFrame({ userId: "u", text: "weather?", timestamp: "" }),
      "STT#0",
    );
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.02);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.02 })] }),
    );
    self._wait(0.02);
    await self._push(
      new FunctionCallInProgressFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: {},
        cancelOnInterruption: false,
      }),
    );
    self._wait(0.03);
    await self._push(
      new FunctionCallResultFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: {},
        result: { ok: true },
      }),
    );
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.02);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.02 })] }),
    );
    await self._push(new LLMTextFrame({ text: "Nice out." }), "LLM#0");
    self._wait(0.02);
    await self._push(ttsAudio(), "TTS#0");
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    await sleep(0.01); // let the event handler task run

    const contributions = self.lastBreakdown.contributions;
    const call = contributions.find((c) => c.label === "function handler")!;
    expect(call).toBeDefined();
    expect(call.owner).toEqual("get_weather");
    expectWithin(call.durationSecs, 0.03, 0.02);

    const writing = contributions.find((c) => c.label === "LLM tool call")!;
    expect(writing).toBeDefined();
    expect(writing.owner).toEqual("LLM#0");
    expect(writing.startTime).toBeLessThan(call.startTime);

    // Nothing left over once the tool spans are named.
    const residual = contributions.find((c) => c.label === "pipeline") ?? null;
    expect(residual).toBeNull();
  });

  test("test_concurrent_handlers_are_one_span", async () => {
    // Handlers dispatched together count their wall clock once.
    await self._push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.02, timestamp: self.clock }));
    await self._push(
      new TranscriptionFrame({ userId: "u", text: "weather and food?", timestamp: "" }),
      "STT#0",
    );
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.02);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.02 })] }),
    );
    for (const [name, callId] of [
      ["get_weather", "1"],
      ["get_restaurant", "2"],
    ] as const) {
      await self._push(
        new FunctionCallInProgressFrame({
          functionName: name,
          toolCallId: callId,
          arguments: {},
          cancelOnInterruption: false,
        }),
      );
    }
    self._wait(0.03);
    await self._push(
      new FunctionCallResultFrame({
        functionName: "get_restaurant",
        toolCallId: "2",
        arguments: {},
        result: {},
      }),
    );
    self._wait(0.05);
    await self._push(
      new FunctionCallResultFrame({
        functionName: "get_weather",
        toolCallId: "1",
        arguments: {},
        result: {},
      }),
    );
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.02);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.02 })] }),
    );
    await self._push(new LLMTextFrame({ text: "Here you go." }), "LLM#0");
    self._wait(0.02);
    await self._push(ttsAudio(), "TTS#0");
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    await sleep(0.01); // let the event handler task run

    const breakdown = self.lastBreakdown;
    const handlers = breakdown.contributions.filter((c) => c.label === "function handler");
    expect(handlers.length).toEqual(1);
    // Named for the handler the wait actually depended on.
    expect(handlers[0]!.owner).toEqual("get_weather +1");
    expectWithin(handlers[0]!.durationSecs, 0.08, 0.02);

    // Overlapping spans would push the sum past the latency they describe.
    const total = breakdown.contributions.reduce((s, c) => s + c.durationSecs, 0);
    expectWithin(total, breakdown.userTurnSecs || total, 0.02);
  });

  test("test_no_two_contributions_overlap", async () => {
    // Spans tile the interval rather than covering the same time twice.
    const breakdown = await self._completeTurn({ hold: true, aggregation: 0.03 });
    const spans = [...breakdown.contributions].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i + 1 < spans.length; i++) {
      const previous = spans[i]!;
      const following = spans[i + 1]!;
      if (previous.label === "pipeline" || following.label === "pipeline") {
        continue;
      }
      expect(previous.startTime + previous.durationSecs).toBeLessThanOrEqual(
        following.startTime + 1e-6,
      );
    }
  });

  test("test_a_long_hold_is_reported_without_waiting_it_out", async () => {
    // A ten second hold costs the test nothing, because the clock is ours.
    const breakdown = await self._completeTurn({ hold: true, holdSecs: 10.0 });
    const wait = breakdown.contributions.find((c) => c.label === "waiting for user")!;
    expect(wait).toBeDefined();
    expect(wait.durationSecs).toBeCloseTo(10.0, 6);
  });

  test("test_durations_are_exact", async () => {
    // Every span is the interval the cycle described, to the microsecond.
    const breakdown = await self._completeTurn({ detect: 0.4, aggregation: 0.25 });
    const byLabel = new Map(breakdown.contributions.map((c) => [c.label, c.durationSecs]));
    // Microseconds apart at most, where a wall clock left tens of them.
    expect(byLabel.get("endpointing wait")!).toBeCloseTo(0.02, 6);
    expect(byLabel.get("turn detection")!).toBeCloseTo(0.4, 6);
    expect(byLabel.get("sentence aggregation")!).toBeCloseTo(0.25, 6);
    expect(byLabel.has("pipeline")).toBe(false);
  });

  test("test_a_turn_held_twice_reports_both_waits", async () => {
    // A turn can be told to wait more than once before it completes.
    await self._push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.02, timestamp: self.clock }));
    self._wait(0.02);
    await self._push(new TranscriptionFrame({ userId: "u", text: "hi", timestamp: "" }), "STT#0");
    for (let i = 0; i < 2; i++) {
      await self._push(new LLMFullResponseStartFrame(), "LLM#0");
      self._wait(0.02);
      await self._push(
        new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.02 })] }),
      );
      await self._push(new LLMMarkerFrame({ marker: "◐" }));
      self._wait(5.0);
    }
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.02);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.02 })] }),
    );
    await self._push(new LLMMarkerFrame({ marker: "●", appendToContextImmediately: false }));
    self._wait(0.02);
    await self._push(new LLMTextFrame({ text: "Go on." }), "LLM#0");
    self._wait(0.02);
    await self._push(ttsAudio(), "TTS#0");
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    await sleep(0.01); // let the event handler task run

    const contributions = self.lastBreakdown.contributions;
    const waits = contributions.filter((c) => c.label === "waiting for user");
    expect(waits.map((w) => round(w.durationSecs, 3))).toEqual([5.0, 5.0]);
    // Each attempt is its own inference: none absorbs a wait.
    const inferences = contributions.filter((c) => c.label === "LLM inference");
    expect(inferences.length).toEqual(3);
    expect(inferences.every((c) => c.durationSecs < 1.0)).toBe(true);
  });

  test("test_a_high_threshold_still_accounts_for_the_whole_interval", async () => {
    // Spans the threshold hides roll into pipeline rather than vanishing.
    await self._observe({ minContributionSecs: 0.1 });
    const breakdown = await self._completeTurn({ aggregation: 0.06 });

    const total = breakdown.contributions.reduce((s, c) => s + c.durationSecs, 0);
    expect(total).toBeCloseTo(self.spokeAt - self.silenceAt, 6);
    const hidden = breakdown.contributions.find((c) => c.label === "pipeline")!;
    expect(hidden).toBeDefined();
    expect(hidden.durationSecs).toBeGreaterThan(0.06);
  });

  test("test_a_turn_says_what_it_was_measured_from", async () => {
    // And carries the interval it measured.
    const breakdown = await self._completeTurn();
    expect(breakdown.measuredFrom).toEqual(MeasuredFrom.USER_SILENCE);
    expect(breakdown.totalSecs).toBeCloseTo(self.spokeAt - self.silenceAt, 6);
  });

  test("test_a_greeting_says_it_was_measured_from_the_connection", async () => {
    // A partial interval is never read as a whole one.
    await self._push(new ClientConnectedFrame());
    self._wait(0.4);
    await self.observer.onPipelineStarted();
    self._wait(0.2);
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.3);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.3 })] }),
    );
    await self._push(new LLMTextFrame({ text: "Hi!" }), "LLM#0");
    self._wait(0.1);
    await self._push(ttsAudio(), "TTS#0");
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    await self._settle();

    const breakdown = self.lastBreakdown;
    expect(breakdown.measuredFrom).toEqual(MeasuredFrom.CLIENT_CONNECTED);
    const lines = breakdown.turnContributionLines();
    expect(lines[lines.length - 1]).toContain("TOTAL (from client connected)");
  });

  test("test_every_part_carries_a_key_and_an_owner_kind", async () => {
    // Which is what a dashboard groups on, rather than the wording.
    const breakdown = await self._completeTurn({ detect: 0.05, aggregation: 0.05 });
    const byKey = new Map(breakdown.contributions.map((c) => [c.key, c]));

    expect(byKey.get("endpointing_wait")!.ownerKind).toEqual(LatencyOwnerKind.SETTING);
    expect(byKey.get("turn_detection")!.ownerKind).toEqual(LatencyOwnerKind.SETTING);
    expect(byKey.get("sentence_aggregation")!.ownerKind).toEqual(LatencyOwnerKind.SETTING);
    expect(byKey.get("llm_inference")!.ownerKind).toEqual(LatencyOwnerKind.SERVICE);
    expect(byKey.get("transcription")!.ownerKind).toEqual(LatencyOwnerKind.SERVICE);
    expect(byKey.get("speech_synthesis")!.ownerKind).toEqual(LatencyOwnerKind.SERVICE);

    // A key never carries the wording of its label.
    for (const contribution of breakdown.contributions) {
      expect(contribution.key).not.toContain(" ");
    }
  });

  test("test_the_greeting_names_the_bot_as_an_owner", async () => {
    // The wait before the LLM is asked is the bot's own code.
    await self._push(new ClientConnectedFrame());
    await self.observer.onPipelineStarted();
    self._wait(0.5);
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.3);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.3 })] }),
    );
    await self._push(new LLMTextFrame({ text: "Hi!" }), "LLM#0");
    self._wait(0.1);
    await self._push(ttsAudio(), "TTS#0");
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    await self._settle();

    const first = self.lastBreakdown.contributions[0]!;
    expect(first.key).toEqual("first_request");
    expect(first.ownerKind).toEqual(LatencyOwnerKind.BOT);
  });
});

// Every label and setting the timeline is allowed to name, so a typo or a
// renamed stage shows up as a failure rather than as odd-looking output.
const KNOWN_LABELS = new Set([
  "endpointing wait",
  "transcription",
  "turn detection",
  "LLM inference",
  "turn completion",
  "waiting for user",
  "awaiting speakable text",
  "LLM tool call",
  "function handler",
  "sentence aggregation",
  "speech synthesis",
  "output transport",
  "pipeline",
]);
const KNOWN_SETTINGS = new Set([
  "config: VAD stop_secs",
  "config: user turn strategies",
  "config: filter_incomplete_user_turns",
  "config: text_aggregation_mode",
]);

interface CycleOptions {
  filtered?: boolean;
  holds?: number;
  tools?: "none" | "one" | "concurrent";
  aggregation?: number;
}

/**
 * Drive one turn of the given shape and return its breakdown.
 *
 * `TestLatencyContributionInvariants._cycle` upstream; a free function so
 * `TestObserverEdges` can drive it on its own driver, as upstream does.
 */
async function _cycle(
  self: _CycleDriver,
  options: CycleOptions = {},
): Promise<LatencyBreakdownType> {
  const filtered = options.filtered ?? true;
  const holds = options.holds ?? 0;
  const tools = options.tools ?? "none";
  const aggregation = options.aggregation ?? 0.0;

  self.silenceAt = self.clock - 0.2;
  await self._push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.2, timestamp: self.clock }));
  self._wait(0.1);
  await self._push(new TranscriptionFrame({ userId: "u", text: "hello", timestamp: "" }), "STT#0");
  self._wait(0.05);

  const inference = async () => {
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.3);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.3 })] }),
    );
  };

  for (let i = 0; i < holds; i++) {
    await inference();
    self._wait(0.02);
    await self._push(new LLMMarkerFrame({ marker: "◐" }));
    self._wait(1.0);
  }

  if (tools !== "none") {
    await inference();
    self._wait(0.05);
    const names = tools === "one" ? ["get_weather"] : ["get_weather", "get_food"];
    for (const [index, name] of names.entries()) {
      await self._push(
        new FunctionCallInProgressFrame({
          functionName: name,
          toolCallId: String(index),
          arguments: {},
          cancelOnInterruption: false,
        }),
      );
    }
    self._wait(0.2);
    for (const [index, name] of names.entries()) {
      await self._push(
        new FunctionCallResultFrame({
          functionName: name,
          toolCallId: String(index),
          arguments: {},
          result: {},
        }),
      );
    }
  }

  await inference();
  if (filtered) {
    await self._push(new LLMMarkerFrame({ marker: "●", appendToContextImmediately: false }));
    self._wait(0.03);
  }
  await self._push(new LLMTextFrame({ text: "Hello there." }), "LLM#0");
  if (aggregation) {
    self._wait(aggregation);
    await self._push(
      new MetricsFrame({
        data: [new TextAggregationMetricsData({ processor: "TTS#0", value: aggregation })],
      }),
    );
  }
  self._wait(0.15);
  await self._push(ttsAudio(), "TTS#0");
  self._wait(0.01);
  await self._push(new BotStartedSpeakingFrame(), "Transport#0");
  self.spokeAt = self.clock;
  await self._settle();
  return self.lastBreakdown;
}

describe("TestLatencyContributionInvariants", () => {
  // Properties that hold for any shape of turn.
  //
  // Where the other tests pin what a particular turn should say, these say what
  // must be true of every turn, so a stage that stops matching its pair of
  // moments fails here rather than quietly becoming pipeline time.
  let self: _CycleDriver;

  beforeEach(async () => {
    self = new _CycleDriver();
    await self.asyncSetUp();
  });

  /** Check what must hold of any timeline. */
  function _assertInvariants(breakdown: LatencyBreakdownType): void {
    const contributions = breakdown.contributions;
    expect(contributions.length).toBeGreaterThan(0);

    // The parts account for the interval they describe.
    const total = contributions.reduce((s, c) => s + c.durationSecs, 0);
    expect(total).toBeCloseTo(self.spokeAt - self.silenceAt, 6);

    // The pipeline entry is a residual spread across the cycle, so it is
    // left out of the checks that treat contributions as a timeline.
    const timeline = contributions.filter((c) => c.label !== "pipeline");
    for (let i = 0; i + 1 < timeline.length; i++) {
      const previous = timeline[i]!;
      const following = timeline[i + 1]!;
      expect(previous.startTime + previous.durationSecs).toBeLessThanOrEqual(
        following.startTime + 1e-9,
      );
    }
    for (const contribution of contributions) {
      expect(contribution.durationSecs).toBeGreaterThanOrEqual(PRINTS_AS_ZERO_SECS);
      expect(contribution.startTime).toBeGreaterThanOrEqual(self.silenceAt - 1e-9);
      expect(contribution.startTime + contribution.durationSecs).toBeLessThanOrEqual(
        self.spokeAt + 1e-9,
      );
      expect(KNOWN_LABELS.has(contribution.label)).toBe(true);
      if (contribution.owner.startsWith("config:")) {
        expect(KNOWN_SETTINGS.has(contribution.owner)).toBe(true);
      }
    }

    // Nothing of substance went unnamed: a stretch the table does not cover
    // means a stage stopped matching its pair of moments.
    const residual = contributions.find((c) => c.label === "pipeline");
    expect(residual ? residual.durationSecs : 0.0).toBeLessThan(0.01);
  }

  test("test_invariants_hold_across_turn_shapes", async () => {
    // Filtering, holds, tools and aggregation, in combination.
    for (const filtered of [true, false]) {
      for (const holds of filtered ? [0, 1, 2] : [0]) {
        for (const tools of ["none", "one", "concurrent"] as const) {
          for (const aggregation of [0.0, 0.06]) {
            // subTest(filtered, holds, tools, aggregation)
            await self._observe();
            const breakdown = await _cycle(self, { filtered, holds, tools, aggregation });
            _assertInvariants(breakdown);
          }
        }
      }
    }
  });
});

describe("TestObserverEdges", () => {
  // Cycles that are interrupted, absent, or follow one another.
  let self: _CycleDriver;

  beforeEach(async () => {
    self = new _CycleDriver();
    await self.asyncSetUp();
  });

  test("test_a_second_complete_marker_is_ignored", async () => {
    // The first completion is the one the turn waited for.
    await self._push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.02, timestamp: self.clock }));
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.02);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.02 })] }),
    );
    await self._push(new LLMMarkerFrame({ marker: "●", appendToContextImmediately: false }));
    const firstMarkerAt = self.clock;
    self._wait(0.05);
    await self._push(new LLMMarkerFrame({ marker: "●", appendToContextImmediately: false }));
    self._wait(0.02);
    await self._push(new LLMTextFrame({ text: "Hi." }), "LLM#0");
    self._wait(0.02);
    await self._push(ttsAudio(), "TTS#0");
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    await self._settle();

    const completion = self.lastBreakdown.contributions.find((c) => c.label === "turn completion")!;
    expect(completion).toBeDefined();
    // The span ends at the first speakable token, so a second marker
    // arriving later neither restarts it nor adds one of its own.
    expect(completion.startTime).toBeLessThanOrEqual(firstMarkerAt);
    expect(
      self.lastBreakdown.contributions.filter((c) => c.label === "turn completion").length,
    ).toEqual(1);
  });

  test("test_an_empty_breakdown_has_nothing_to_print", () => {
    // A breakdown with no contributions formats as nothing at all.
    expect(new LatencyBreakdown().turnContributionLines()).toEqual([]);
  });

  test("test_upstream_frames_are_ignored", async () => {
    // Only what flows towards the user shapes the timeline.
    await self.observer.onPushFrame(
      new FramePushed({
        source: new IdentityFilter({ name: "STT#0" }),
        destination: new IdentityFilter({ name: "destination" }),
        frame: new VADUserStoppedSpeakingFrame({ stopSecs: 0.02, timestamp: self.clock }),
        direction: FrameDirection.UPSTREAM,
        timestamp: 0,
      }),
    );
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    await self._settle();
    expect(self.breakdowns).toEqual([]);
  });

  test("test_metrics_outside_a_cycle_are_ignored", async () => {
    // A metric arriving before any user turn records nothing.
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.5 })] }),
    );
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    await self._settle();
    expect(self.breakdowns).toEqual([]);
  });

  test("test_a_greeting_is_measured_from_where_startup_ends", async () => {
    // The first thing the bot says has a timeline of its own.
    await self._push(new ClientConnectedFrame());
    self._wait(0.4);
    // StartupTimingObserver stops here, so this timeline starts here.
    await self.observer.onPipelineStarted();
    const readyAt = self.clock;
    self._wait(1.1);
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.3);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.3 })] }),
    );
    await self._push(new LLMTextFrame({ text: "Hi there!" }), "LLM#0");
    self._wait(0.1);
    await self._push(ttsAudio(), "TTS#0");
    self._wait(0.02);
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    const spokeAt = self.clock;
    await self._settle();

    const contributions = self.lastBreakdown.contributions;
    expect(contributions.map((c) => c.label)).toEqual([
      "first request",
      "LLM inference",
      "speech synthesis",
      "output transport",
    ]);
    // Waiting to be asked is most of a greeting, and no service reports it.
    const firstRequest = contributions[0]!;
    expect(firstRequest.owner).toEqual("bot");
    expect(firstRequest.durationSecs).toBeCloseTo(1.1, 6);
    // The startup report owns everything before the pipeline was ready.
    expect(contributions.reduce((s, c) => s + c.durationSecs, 0)).toBeCloseTo(spokeAt - readyAt, 6);
  });

  test("test_a_greeting_waits_for_whichever_came_second", async () => {
    // A client that joins after the pipeline started sets the start.
    await self.observer.onPipelineStarted();
    self._wait(2.0); // nobody on the call yet
    await self._push(new ClientConnectedFrame());
    const connectedAt = self.clock;
    self._wait(0.2);
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.3);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.3 })] }),
    );
    await self._push(new LLMTextFrame({ text: "Hi!" }), "LLM#0");
    self._wait(0.1);
    await self._push(ttsAudio(), "TTS#0");
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    const spokeAt = self.clock;
    await self._settle();

    const contributions = self.lastBreakdown.contributions;
    // The two seconds spent waiting for someone to join are nobody's cost.
    expect(contributions.reduce((s, c) => s + c.durationSecs, 0)).toBeCloseTo(
      spokeAt - connectedAt,
      6,
    );
    expect(contributions[0]!.durationSecs).toBeCloseTo(0.2, 6);
  });

  test("test_a_greeting_carries_no_user_turn", async () => {
    // Which is how a consumer tells the two kinds of cycle apart.
    await self._push(new ClientConnectedFrame());
    self._wait(0.5);
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    await self._settle();
    expect(self.lastBreakdown.userTurnStartTime).toBeNull();
    expect(self.lastBreakdown.userTurnSecs).toBeNull();
  });

  test("test_an_interruption_discards_the_cycle", async () => {
    // Frames from a cancelled cycle do not reach the next one.
    await self._push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.02, timestamp: self.clock }));
    await self._push(new TranscriptionFrame({ userId: "u", text: "wait", timestamp: "" }), "STT#0");
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.3);
    await self._push(new InterruptionFrame());

    self.silenceAt = self.clock - 0.02;
    await self._push(new VADUserStoppedSpeakingFrame({ stopSecs: 0.02, timestamp: self.clock }));
    await self._push(new TranscriptionFrame({ userId: "u", text: "go", timestamp: "" }), "STT#0");
    await self._push(new LLMFullResponseStartFrame(), "LLM#0");
    self._wait(0.02);
    await self._push(
      new MetricsFrame({ data: [new TTFBMetricsData({ processor: "LLM#0", value: 0.02 })] }),
    );
    await self._push(new LLMTextFrame({ text: "Hi." }), "LLM#0");
    self._wait(0.02);
    await self._push(ttsAudio(), "TTS#0");
    await self._push(new BotStartedSpeakingFrame(), "Transport#0");
    self.spokeAt = self.clock;
    await self._settle();

    const contributions = self.lastBreakdown.contributions;
    const total = contributions.reduce((s, c) => s + c.durationSecs, 0);
    expect(total).toBeCloseTo(self.spokeAt - self.silenceAt, 6);
    // The abandoned inference is not in the timeline it preceded.
    expect(contributions.filter((c) => c.label === "LLM inference").length).toEqual(1);
  });

  test("test_one_cycle_does_not_reach_the_next", async () => {
    // Back to back turns are measured independently.
    const first = await _cycle(self, { holds: 1 });
    const firstTotal = first.contributions.reduce((s, c) => s + c.durationSecs, 0);
    const second = await _cycle(self);
    const secondTotal = second.contributions.reduce((s, c) => s + c.durationSecs, 0);

    expect(secondTotal).toBeCloseTo(self.spokeAt - self.silenceAt, 6);
    expect(secondTotal).toBeLessThan(firstTotal);
    expect(second.contributions.map((c) => c.label)).not.toContain("waiting for user");
  });
});

describe("TestFrameContracts", () => {
  // What the observer assumes about the frames other components push.
  //
  // These read the real classes rather than the frames a test makes up, so a
  // change to the conventions the timeline is built on fails here.

  test("test_a_marker_is_stand_alone_unless_it_prefixes_a_response", () => {
    // Which the observer reads as an incomplete turn.
    expect(new LLMMarkerFrame({ marker: "◐" }).appendToContextImmediately).toBe(true);
    expect(
      new LLMMarkerFrame({ marker: "●", appendToContextImmediately: false })
        .appendToContextImmediately,
    ).toBe(false);
  });

  /** Run one response through the turn completion protocol. */
  async function _markersPushedFor(text: string): Promise<LLMMarkerFrame[]> {
    const processor = new _MarkerProcessor();
    // An incomplete verdict arms a timeout, which needs somewhere to run.
    await processor.setup(frameProcessorSetup(new TaskManager()));
    const pushed: Frame[] = [];
    (processor as Loose).pushFrame = mock(async (f: Frame, ..._args: unknown[]) => {
      pushed.push(f);
    });

    await processor._pushTurnText(text);
    return pushed.filter((f): f is LLMMarkerFrame => f instanceof LLMMarkerFrame);
  }

  test("test_turn_completion_pushes_markers_that_way_round", async () => {
    // An incomplete verdict stands alone; a complete one prefixes the reply.
    const incomplete = await _markersPushedFor(USER_TURN_INCOMPLETE_SHORT_MARKER);
    expect(incomplete.map((m) => m.marker)).toEqual([USER_TURN_INCOMPLETE_SHORT_MARKER]);
    expect(incomplete[0]!.appendToContextImmediately).toBe(true);

    const complete = await _markersPushedFor(`${USER_TURN_COMPLETE_MARKER} Hello!`);
    expect(complete.map((m) => m.marker)).toEqual([USER_TURN_COMPLETE_MARKER]);
    expect(complete[0]!.appendToContextImmediately).toBe(false);
  });

  test("test_a_metric_names_the_processor_that_reported_it", () => {
    // Which is how an inference is matched to the request that opened it.
    const processor = new IdentityFilter({ name: "LLMService#7" });
    expect((processor as Loose)._metrics._processorName()).toEqual(processor.name);
  });
});
