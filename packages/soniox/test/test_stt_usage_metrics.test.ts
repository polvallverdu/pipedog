// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_stt_usage_metrics.py

/**
 * Tests for STT usage metrics accounting and emission.
 *
 * Porting notes:
 * - `frame_processor_setup` (tests/frame_processor_helpers.py) is ported
 *   locally.
 * - `AsyncMock` becomes `mock()` from `bun:test`.
 * - `pytest.approx` becomes `toBeCloseTo`.
 * - The OpenTelemetry tests run when core can load `@opentelemetry/api` (an
 *   optional peer of `@pipedog/core`).
 */

import { expect, mock, test } from "bun:test";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import {
  type Frame,
  InputAudioRawFrame,
  MetricsFrame,
  STTMetadataFrame,
} from "@pipedog/core/frames/frames";
import { STTUsage, STTUsageMetricsData } from "@pipedog/core/metrics/metrics";
import { PipelineParams } from "@pipedog/core/pipeline/worker";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import { FrameProcessorMetrics } from "@pipedog/core/processors/metrics/frame_processor_metrics";
import { STTSettings } from "@pipedog/core/services/settings";
import {
  STTService,
  type STTServiceOptions,
  WebsocketSTTService,
  type WebsocketSTTServiceOptions,
} from "@pipedog/core/services/stt_service";
import { runTest } from "@pipedog/core/tests/utils";
import { type BaseTaskManager, TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { _addSttUsageToSpan } from "@pipedog/core/utils/tracing/service_decorators";
import { loadOpenTelemetry } from "@pipedog/core/utils/tracing/setup";
import { SonioxSTTService } from "../src/stt.ts";

const SAMPLE_RATE = 16000;

/** Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`. */
function frameProcessorSetup(
  taskManager: BaseTaskManager,
  options: Partial<FrameProcessorSetupOptions> = {},
): FrameProcessorSetup {
  return new FrameProcessorSetup({
    clock: new SystemClock(),
    pipelineWorker: null,
    ...options,
    taskManager,
  });
}

/** Continuous STT service that produces no transcripts. */
class FakeSTTService extends STTService {
  constructor(options: STTServiceOptions = {}) {
    super({ settings: new STTSettings({ model: null, language: null }), ...options });
  }

  override canGenerateMetrics(): boolean {
    return true;
  }

  async *runStt(_audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    yield null;
  }
}

/** Websocket STT service using the default silence keepalive. */
class FakeWebsocketSTTService extends WebsocketSTTService {
  constructor(options: WebsocketSTTServiceOptions = {}) {
    super({ settings: new STTSettings({ model: null, language: null }), ...options });
  }

  override canGenerateMetrics(): boolean {
    return true;
  }

  async *runStt(_audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {
    yield null;
  }

  async _connectWebsocket(): Promise<void> {}

  async _disconnectWebsocket(): Promise<void> {}

  async _receiveMessages(): Promise<void> {}
}

function audioFrame(seconds: number): InputAudioRawFrame {
  const numSamples = Math.trunc(SAMPLE_RATE * seconds);
  return new InputAudioRawFrame({
    audio: new Uint8Array(numSamples * 2),
    sampleRate: SAMPLE_RATE,
    numChannels: 1,
  });
}

test("test_collector_returns_stt_usage_metrics_frame", async () => {
  const metrics = new FrameProcessorMetrics();
  metrics.setProcessorName("stt");

  const frame = await metrics.startSttUsageMetrics(new STTUsage({ audioSeconds: 1.25 }));

  expect(frame).toBeInstanceOf(MetricsFrame);
  expect(frame.data).toHaveLength(1);
  const data = frame.data[0] as STTUsageMetricsData;
  expect(data).toBeInstanceOf(STTUsageMetricsData);
  expect(data.processor).toBe("stt");
  expect(data.value.audioSeconds).toBe(1.25);
});

test("test_emit_reports_accumulated_audio_and_resets", async () => {
  const service = new FakeSTTService({ sampleRate: SAMPLE_RATE });
  (service as any)._sampleRate = SAMPLE_RATE;
  (service as any)._setup = frameProcessorSetup(new TaskManager(), { enableUsageMetrics: true });
  const pushed: MetricsFrame[] = [];
  (service as any).pushFrame = mock(async (f: MetricsFrame) => {
    pushed.push(f);
  });

  (service as any)._recordSttAudioUsage(new Uint8Array(SAMPLE_RATE * 2)); // 1s
  (service as any)._recordSttAudioUsage(new Uint8Array(SAMPLE_RATE)); // 0.5s
  await service.emitSttUsageMetrics();

  expect(pushed).toHaveLength(1);
  const usage = ((pushed[0] as MetricsFrame).data[0] as STTUsageMetricsData).value;
  expect(usage.audioSeconds).toBeCloseTo(1.5);

  // Pending was consumed: a second emit with no new audio is a no-op.
  await service.emitSttUsageMetrics();
  expect(pushed).toHaveLength(1);
});

test("test_emit_gated_off_pushes_nothing_but_resets_pending", async () => {
  const service = new FakeSTTService({ sampleRate: SAMPLE_RATE });
  (service as any)._sampleRate = SAMPLE_RATE;
  (service as any)._setup = frameProcessorSetup(new TaskManager(), { enableUsageMetrics: false });
  const pushed: Frame[] = [];
  (service as any).pushFrame = mock(async (f: Frame) => {
    pushed.push(f);
  });

  (service as any)._recordSttAudioUsage(new Uint8Array(SAMPLE_RATE * 2));
  await service.emitSttUsageMetrics();

  expect(pushed).toEqual([]);
  expect((service as any)._sttUsagePendingSeconds).toBe(0.0);
});

test("test_stop_flushes_trailing_audio_usage", async () => {
  const service = new FakeSTTService({ sampleRate: SAMPLE_RATE });

  const [receivedDown] = await runTest(service, {
    framesToSend: [audioFrame(1.0), audioFrame(0.5)],
    expectedDownFrames: [STTMetadataFrame, InputAudioRawFrame, InputAudioRawFrame, MetricsFrame],
    pipelineParams: new PipelineParams({ enableUsageMetrics: true }),
  });

  const metricsFrame = receivedDown.at(-1) as MetricsFrame;
  const data = metricsFrame.data[0];
  expect(data).toBeInstanceOf(STTUsageMetricsData);
  expect((data as STTUsageMetricsData).value.audioSeconds).toBeCloseTo(1.5);
});

test("test_usage_metrics_disabled_by_default", async () => {
  const service = new FakeSTTService({ sampleRate: SAMPLE_RATE });

  await runTest(service, {
    framesToSend: [audioFrame(1.0)],
    expectedDownFrames: [STTMetadataFrame, InputAudioRawFrame],
  });
});

test("test_default_keepalive_silence_counts_toward_usage", async () => {
  const service = new FakeWebsocketSTTService({ sampleRate: SAMPLE_RATE });
  (service as any)._sampleRate = SAMPLE_RATE;
  (service as any)._setup = frameProcessorSetup(new TaskManager(), { enableUsageMetrics: true });
  service._websocket = { send: mock(async () => {}) } as any;

  const silence = new Uint8Array(SAMPLE_RATE); // 0.5s at 16kHz mono 16-bit
  await (service as any)._sendKeepalive(silence);

  expect((service as any)._sttUsagePendingSeconds).toBeCloseTo(0.5);
});

// Core resolves `@opentelemetry/api` (a core devDependency, optional peer); ask it
// rather than importing the module from this package.
const HAS_OPENTELEMETRY = await loadOpenTelemetry();

class FakeSpan {
  attributes: Record<string, unknown> = {};

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }
}

test.skipIf(!HAS_OPENTELEMETRY)("test_add_stt_usage_to_span_sets_attributes", () => {
  const span = new FakeSpan();
  _addSttUsageToSpan(span as never, new STTUsage({ audioSeconds: 1.5 }));
  expect(span.attributes).toEqual({ "metrics.audio_seconds": 1.5 });
});

test.skipIf(!HAS_OPENTELEMETRY)("test_traced_stt_accumulates_pending_usage_for_span", async () => {
  // SonioxSTTService is decorated with traced STT, so its
  // startSttUsageMetrics is wrapped to accumulate usage into the STT
  // span state (attached to the span when it closes).
  const service = new SonioxSTTService({ apiKey: "test-key" });
  (service as any)._tracingEnabled = true;

  await service.startSttUsageMetrics(new STTUsage({ audioSeconds: 1.0 }));
  await service.startSttUsageMetrics(new STTUsage({ audioSeconds: 0.5 }));

  const pending = (service as any)._sttSpanState.pendingUsage;
  expect(pending.audioSeconds).toBeCloseTo(1.5);
});
