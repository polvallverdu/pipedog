// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_rtvi_observer_metrics.py

/** Tests for RTVIObserver metrics handling. */

import { describe, expect, mock, test } from "bun:test";
import { MetricsFrame } from "../src/frames/frames.ts";
import {
  LLMTokenUsage,
  LLMUsageMetricsData,
  ProcessingMetricsData,
  STTUsage,
  STTUsageMetricsData,
  TTFAMetricsData,
  TTFBMetricsData,
  TTSUsageMetricsData,
} from "../src/metrics/metrics.ts";
import { RTVIObserver, RTVIObserverParams } from "../src/processors/frameworks/rtvi/observer.ts";

type SentMessage = { data: Record<string, Record<string, unknown>[]> };

// `_handleMetrics` is protected; tests call it directly, as upstream does.
function handleMetrics(observer: RTVIObserver, frame: MetricsFrame): Promise<void> {
  return (observer as unknown as { _handleMetrics(f: MetricsFrame): Promise<void> })._handleMetrics(
    frame,
  );
}

function newObserver(): { observer: RTVIObserver; sent: SentMessage[] } {
  const observer = new RTVIObserver(null, {
    params: new RTVIObserverParams({ metricsEnabled: true }),
  });
  const sent: SentMessage[] = [];
  observer.sendRtviMessage = mock(async (m: unknown) => {
    sent.push(m as SentMessage);
  });
  return { observer, sent };
}

describe("TestRTVIObserverMetrics", () => {
  test("test_ttfb_and_ttfa_forwarded_to_clients", async () => {
    // TTFB and TTFA are emitted in separate frames during a real TTS turn;
    // both must reach RTVI clients.
    const { observer, sent } = newObserver();

    await handleMetrics(
      observer,
      new MetricsFrame({
        data: [
          new TTFBMetricsData({ processor: "cartesia_tts", value: 0.2, model: "sonic-english" }),
        ],
      }),
    );
    await handleMetrics(
      observer,
      new MetricsFrame({
        data: [
          new TTFAMetricsData({
            processor: "cartesia_tts",
            ttfa: 0.6,
            ttfb: 0.2,
            leadingSilence: 0.4,
            model: "sonic-english",
          }),
        ],
      }),
    );

    expect(sent.length).toEqual(2);
    expect(sent[0]!.data).toHaveProperty("ttfb");
    expect(sent[0]!.data.ttfb![0]!.value).toEqual(0.2);
    expect(sent[1]!.data).toHaveProperty("ttfa");
    expect(sent[1]!.data.ttfa![0]!.leading_silence).toEqual(0.4);
  });

  test("test_all_metric_types_accumulate_into_one_message", async () => {
    // A single frame can carry several metric types; each must land under its
    // own key in one outgoing message. LLM usage is special-cased: the message
    // carries the nested token-usage value, not the wrapper.
    const { observer, sent } = newObserver();

    await handleMetrics(
      observer,
      new MetricsFrame({
        data: [
          new TTFBMetricsData({ processor: "cartesia_tts", value: 0.2 }),
          new TTFAMetricsData({
            processor: "cartesia_tts",
            ttfa: 0.6,
            ttfb: 0.2,
            leadingSilence: 0.4,
          }),
          new ProcessingMetricsData({ processor: "llm", value: 0.05 }),
          new LLMUsageMetricsData({
            processor: "llm",
            value: new LLMTokenUsage({
              promptTokens: 10,
              completionTokens: 20,
              totalTokens: 30,
              inputAudioTokens: 7,
              outputAudioTokens: 13,
            }),
          }),
          new STTUsageMetricsData({
            processor: "soniox_stt",
            value: new STTUsage({ audioSeconds: 1.5 }),
          }),
          new TTSUsageMetricsData({ processor: "cartesia_tts", value: 42 }),
        ],
      }),
    );

    expect(sent.length).toEqual(1);
    const data = sent[0]!.data;
    expect(data.ttfb![0]!.value).toEqual(0.2);
    expect(data.ttfa![0]!.leading_silence).toEqual(0.4);
    expect(data.processing![0]!.value).toEqual(0.05);
    // LLM usage unwraps to the token-usage payload.
    expect(data.tokens![0]!.total_tokens).toEqual(30);
    // Populated optional fields are included; unset ones are dropped
    // entirely (exclude_none) rather than sent as null.
    expect(data.tokens![0]!.input_audio_tokens).toEqual(7);
    expect(data.tokens![0]!.output_audio_tokens).toEqual(13);
    expect(Object.keys(data.tokens![0]!)).not.toContain("cache_read_input_audio_tokens");
    expect((data.stt_usage![0]!.value as Record<string, unknown>).audio_seconds).toEqual(1.5);
    expect(data.stt_usage![0]!.processor).toEqual("soniox_stt");
    expect(data.characters![0]!.value).toEqual(42);
  });
});
