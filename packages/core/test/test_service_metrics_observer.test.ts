// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_service_metrics_observer.py

import { beforeEach, describe, expect, test } from "bun:test";
import { sleep } from "@pipecat-ts/asyncio";
import { type Frame, MetricsFrame, TextFrame } from "../src/frames/frames.ts";
import {
  LLMTokenUsage,
  LLMUsageMetricsData,
  ProcessingMetricsData,
  STTUsage,
  STTUsageMetricsData,
  TextAggregationMetricsData,
  TTFAMetricsData,
  TTFATMetricsData,
  TTFBMetricsData,
  TTSUsageMetricsData,
  TurnMetricsData,
} from "../src/metrics/metrics.ts";
import { FramePushed } from "../src/observers/base_observer.ts";
import {
  ServiceLatencyKind,
  type ServiceLatencyRecord,
  ServiceMetricsObserver,
  ServiceUsageKind,
  type ServiceUsageRecord,
} from "../src/observers/service_metrics_observer.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { FrameDirection } from "../src/processors/frame_processor.ts";
import { TaskManager } from "../src/utils/asyncio/task_manager.ts";

/** Each metric a service reports becomes one record. */
describe("TestServiceMetricsObserver", () => {
  let clock: number;
  let observer: ServiceMetricsObserver;
  let latency: ServiceLatencyRecord[];
  let usage: ServiceUsageRecord[];

  beforeEach(async () => {
    clock = 1_000_000.0;
    observer = new ServiceMetricsObserver({ timeSource: () => clock });
    // Event handlers run as tasks, so the observer needs a task manager.
    await observer.setup(new TaskManager());
    latency = [];
    usage = [];

    observer.eventHandler(
      "on_service_latency",
      async (_observer: unknown, record: ServiceLatencyRecord) => {
        latency.push(record);
      },
    );

    observer.eventHandler(
      "on_service_usage",
      async (_observer: unknown, record: ServiceUsageRecord) => {
        usage.push(record);
      },
    );
  });

  /** Feed one frame to the observer, as a pipeline push would. */
  async function push(frame: Frame, source = "source"): Promise<void> {
    await observer.onPushFrame(
      new FramePushed({
        source: new IdentityFilter({ name: source }),
        destination: new IdentityFilter({ name: "destination" }),
        frame,
        direction: FrameDirection.DOWNSTREAM,
        timestamp: 0,
      }),
    );
    // Event handlers run as tasks, so give them a chance to deliver.
    await settle();
  }

  async function settle(): Promise<void> {
    await sleep(0.01);
  }

  /** The simplest measurement, carried as seconds. */
  test("test_time_to_first_byte", async () => {
    await push(
      new MetricsFrame({
        data: [
          new TTFBMetricsData({ processor: "OpenAILLMService#0", model: "gpt-4.1", value: 0.757 }),
        ],
      }),
    );
    const record = latency[0]!;
    expect(record.kind).toEqual(ServiceLatencyKind.TTFB);
    expect(record.processor).toEqual("OpenAILLMService#0");
    expect(record.model).toEqual("gpt-4.1");
    expect(record.seconds).toEqual(0.757);
    expect(record.timestamp).toEqual(clock);
    expect(record.ttfbSecs).toBeNull();
  });

  /** A measurement that decomposes reports its parts. */
  test("test_time_to_first_audio_keeps_what_it_builds_on", async () => {
    await push(
      new MetricsFrame({
        data: [
          new TTFAMetricsData({
            processor: "CartesiaTTSService#0",
            ttfa: 0.31,
            ttfb: 0.13,
            leadingSilence: 0.18,
          }),
        ],
      }),
    );
    const record = latency[0]!;
    expect(record.kind).toEqual(ServiceLatencyKind.TTFA);
    expect(record.seconds).toEqual(0.31);
    expect(record.ttfbSecs).toEqual(0.13);
    expect(record.leadingSilenceSecs).toEqual(0.18);
  });

  /** Thinking time is what separates the answer from the first byte. */
  test("test_time_to_first_answer_token_keeps_the_thinking", async () => {
    await push(
      new MetricsFrame({
        data: [
          new TTFATMetricsData({ processor: "LLM#0", ttfat: 1.4, ttfb: 0.4, thinkingTime: 1.0 }),
        ],
      }),
    );
    const record = latency[0]!;
    expect(record.kind).toEqual(ServiceLatencyKind.TTFAT);
    expect(record.seconds).toEqual(1.4);
    expect(record.ttfbSecs).toEqual(0.4);
    expect(record.thinkingTimeSecs).toEqual(1.0);
  });

  /** Every token count a model reports survives into the record. */
  test("test_llm_tokens_including_the_optional_ones", async () => {
    await push(
      new MetricsFrame({
        data: [
          new LLMUsageMetricsData({
            processor: "OpenAILLMService#0",
            model: "gpt-4.1",
            value: new LLMTokenUsage({
              promptTokens: 298,
              completionTokens: 58,
              totalTokens: 356,
              cacheReadInputTokens: 128,
              reasoningTokens: 12,
            }),
          }),
        ],
      }),
    );
    const record = usage[0]!;
    expect(record.kind).toEqual(ServiceUsageKind.LLM);
    expect(record.model).toEqual("gpt-4.1");
    expect(record.promptTokens).toEqual(298);
    expect(record.completionTokens).toEqual(58);
    expect(record.totalTokens).toEqual(356);
    expect(record.cacheReadInputTokens).toEqual(128);
    expect(record.reasoningTokens).toEqual(12);
    // Fields for other kinds of service stay empty.
    expect(record.characters).toBeNull();
    expect(record.audioSeconds).toBeNull();
  });

  /** Audio in, characters out. */
  test("test_speech_to_text_and_text_to_speech_usage", async () => {
    await push(
      new MetricsFrame({
        data: [
          new STTUsageMetricsData({
            processor: "DeepgramSTTService#0",
            value: new STTUsage({ audioSeconds: 42.24 }),
          }),
        ],
      }),
    );
    await push(
      new MetricsFrame({
        data: [new TTSUsageMetricsData({ processor: "CartesiaTTSService#0", value: 87 })],
      }),
    );
    expect(usage[0]!.kind).toEqual(ServiceUsageKind.STT);
    expect(usage[0]!.audioSeconds).toEqual(42.24);
    expect(usage[1]!.kind).toEqual(ServiceUsageKind.TTS);
    expect(usage[1]!.characters).toEqual(87);
  });

  /** Two inferences report twice, and the records stay apart. */
  test("test_nothing_is_summed", async () => {
    for (const tokens of [10, 20]) {
      await push(
        new MetricsFrame({
          data: [
            new LLMUsageMetricsData({
              processor: "LLM#0",
              value: new LLMTokenUsage({
                promptTokens: tokens,
                completionTokens: 1,
                totalTokens: tokens + 1,
              }),
            }),
          ],
        }),
      );
    }
    expect(usage.map((r) => r.promptTokens)).toEqual([10, 20]);
  });

  /** Only what a service made someone wait for is a record. */
  test("test_metrics_measuring_something_else_are_left_alone", async () => {
    await push(
      new MetricsFrame({
        data: [
          new ProcessingMetricsData({ processor: "LLM#0", value: 1.11 }),
          new TextAggregationMetricsData({ processor: "TTS#0", value: 0.226 }),
          // Upstream uses SmartTurnMetricsData, which is deprecated and not
          // ported; it only adds two timing fields to TurnMetricsData, its
          // non-deprecated base, which is what services report now.
          new TurnMetricsData({
            processor: "SmartTurn#0",
            isComplete: true,
            probability: 0.9,
            e2eProcessingTimeMs: 18.0,
          }),
        ],
      }),
    );
    expect(latency).toEqual([]);
    expect(usage).toEqual([]);
  });

  /** Only metrics frames carry metrics. */
  test("test_other_frames_are_ignored", async () => {
    await push(new TextFrame({ text: "hello" }));
    expect(latency).toEqual([]);
    expect(usage).toEqual([]);
  });

  /** Each becomes its own record. */
  test("test_one_frame_can_carry_several_metrics", async () => {
    await push(
      new MetricsFrame({
        data: [
          new TTFBMetricsData({ processor: "LLM#0", value: 0.3 }),
          new LLMUsageMetricsData({
            processor: "LLM#0",
            value: new LLMTokenUsage({ promptTokens: 5, completionTokens: 5, totalTokens: 10 }),
          }),
        ],
      }),
    );
    expect(latency.length).toEqual(1);
    expect(usage.length).toEqual(1);
  });
});
