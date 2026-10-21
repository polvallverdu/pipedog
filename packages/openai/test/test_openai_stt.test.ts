// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_stt.py

import { expect, test } from "bun:test";

import {
  InputAudioRawFrame,
  MetricsFrame,
  TranscriptionFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { STTUsageMetricsData } from "@pipedog/core/metrics/metrics";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import { runTest } from "@pipedog/core/tests/utils";
import { ExternalUserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import type { Transcription } from "@pipedog/whisper/base_stt";

import { OpenAIRealtimeSTTService, OpenAISTTService } from "../src/stt.ts";

const SAMPLE_RATE = 16000;

/** The protected members these tests reach into, as upstream does. */
interface SttInternals {
  _client: { audio: { transcriptions: { create: (kwargs: any) => Promise<unknown> } } };
  _transcribe: (audio: Uint8Array) => Promise<Transcription>;
}

test("test_segment_emits_usage_and_transcription", async () => {
  // No trailing padding, so usage equals the buffered audio.
  const service = new OpenAISTTService({ apiKey: "test-key", trailingSilenceSecs: 0 });

  const fakeTranscribe = async (_audio: Uint8Array): Promise<Transcription> =>
    ({ text: "hello world" }) as Transcription;

  (service as unknown as SttInternals)._transcribe = fakeTranscribe;

  // 1s of 16-bit mono audio: each sample is the bytes 0x01 0x02.
  const pcm = new Uint8Array(SAMPLE_RATE * 2);
  for (let i = 0; i < pcm.length; i += 2) {
    pcm[i] = 0x01;
    pcm[i + 1] = 0x02;
  }

  const [receivedDown] = await runTest(service, {
    framesToSend: [
      new VADUserStartedSpeakingFrame(),
      new InputAudioRawFrame({ audio: pcm, sampleRate: SAMPLE_RATE, numChannels: 1 }),
      new VADUserStoppedSpeakingFrame(),
    ],
    pipelineParams: new PipelineParams({ enableUsageMetrics: true }),
  });

  const transcripts = receivedDown.filter(
    (f): f is TranscriptionFrame => f instanceof TranscriptionFrame,
  );
  expect(transcripts.length).toBe(1);
  expect(transcripts[0].text).toBe("hello world");
  expect(transcripts[0].finalized).toBe(true);

  const usageIndexes: number[] = [];
  receivedDown.forEach((f, i) => {
    if (f instanceof MetricsFrame && f.data.some((d) => d instanceof STTUsageMetricsData)) {
      usageIndexes.push(i);
    }
  });
  expect(usageIndexes.length).toBe(1);
  const usageFrame = receivedDown[usageIndexes[0]] as MetricsFrame;
  const usage = usageFrame.data.find(
    (d) => d instanceof STTUsageMetricsData,
  ) as STTUsageMetricsData;
  // pytest.approx: relative tolerance of 1e-6.
  const expectedSeconds = pcm.length / (SAMPLE_RATE * 2);
  expect(Math.abs(usage.value.audioSeconds - expectedSeconds)).toBeLessThanOrEqual(
    1e-6 * Math.abs(expectedSeconds),
  );

  // Usage precedes the transcript so tracing attaches it to the span the
  // finalized TranscriptionFrame closes.
  expect(usageIndexes[0]).toBeLessThan(receivedDown.indexOf(transcripts[0]));
});

test("test_openai_realtime_should_interrupt_rides_on_recommended_strategies", () => {
  // should_interrupt configures the strategies the service recommends via its
  // metadata frame; the service never broadcasts the interruption itself.
  for (const shouldInterrupt of [true, false]) {
    const service = new OpenAIRealtimeSTTService({
      apiKey: "test-key",
      turnDetection: { type: "server_vad" },
      shouldInterrupt,
    });
    const strategies = service.serviceMetadataFrame().userTurnStrategies;
    expect(strategies).toBeInstanceOf(ExternalUserTurnStrategies);
    expect((strategies as ExternalUserTurnStrategies).enableInterruptions).toBe(shouldInterrupt);
  }
});

test("test_openai_realtime_server_defaults_recommend_strategies", () => {
  // `turnDetection: null` omits the field, so the session's own default stands.
  // That default detects turns, so the recommendation applies just as it does
  // for an explicit configuration.
  const service = new OpenAIRealtimeSTTService({ apiKey: "test-key", turnDetection: null });
  const strategies = service.serviceMetadataFrame().userTurnStrategies;
  expect(strategies).toBeInstanceOf(ExternalUserTurnStrategies);
});

test("test_openai_realtime_local_vad_mode_recommends_no_strategies", () => {
  // With turn detection off the server reports no boundaries to propose.
  const service = new OpenAIRealtimeSTTService({ apiKey: "test-key" });
  expect(service.serviceMetadataFrame().userTurnStrategies).toBeNull();
});

// Probability metrics are requested in the form each model family accepts.
const probMetricsCases: [string, Record<string, unknown>][] = [
  ["gpt-transcribe", { response_format: "json", include: ["logprobs"] }],
  ["whisper-1", { response_format: "verbose_json" }],
  ["gpt-4o-transcribe-diarize", {}],
];

for (const [model, expected] of probMetricsCases) {
  test(`test_prob_metrics_request_shape[${model}]`, async () => {
    // Probability metrics are requested in the form each model family accepts.
    const service = new OpenAISTTService({
      apiKey: "test-key",
      settings: new OpenAISTTService.Settings({ model }),
      includeProbMetrics: true,
    });

    const captured: Record<string, unknown> = {};

    const fakeCreate = async (kwargs: Record<string, unknown>) => {
      Object.assign(captured, kwargs);
      return { text: "hello world" } as Transcription;
    };

    (service as unknown as SttInternals)._client.audio.transcriptions.create = fakeCreate;

    await (service as unknown as SttInternals)._transcribe(new Uint8Array([0x01, 0x02]));

    expect(captured.model).toBe(model);
    const picked: Record<string, unknown> = {};
    for (const k of ["response_format", "include"]) {
      if (k in captured) picked[k] = captured[k];
    }
    expect(picked).toEqual(expected);
  });
}
