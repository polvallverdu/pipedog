// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ttfb_metrics.py

/**
 * Tests for time-to-first-byte (TTFB) metrics.
 *
 * TTFB measures from a request to the first output answering it. Output that
 * predates the request cannot be that answer, and reporting the negative interval
 * it produces would put an impossible latency into a metrics stream. These tests
 * cover that boundary in the metrics themselves, and in the STT timeout path that
 * can reach it by measuring to a transcript from an earlier segment.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { time } from "@pipecat-ts/asyncio";

import type { Frame } from "../src/frames/frames.ts";
import { TTFBMetricsData } from "../src/metrics/metrics.ts";
import { FrameProcessorMetrics } from "../src/processors/metrics/frame_processor_metrics.ts";
import { STTService } from "../src/services/stt_service.ts";

function _metrics(): FrameProcessorMetrics {
  const metrics = new FrameProcessorMetrics();
  metrics.setProcessorName("TestProcessor");
  return metrics;
}

describe("TestStopTTFBMetrics", () => {
  /** A response after the request reports the time between them. */
  test("test_reports_a_normal_interval", async () => {
    const metrics = _metrics();
    const start = time();
    await metrics.startTtfbMetrics({ startTime: start, reportOnlyInitialTtfb: false });

    const frame = await metrics.stopTtfbMetrics({ endTime: start + 0.25 });

    expect(frame).not.toBeNull();
    expect(frame!.data).toHaveLength(1);
    const [data] = frame!.data;
    expect(data).toBeInstanceOf(TTFBMetricsData);
    expect((data as TTFBMetricsData).value).toBeCloseTo(0.25, 6);
  });

  /** Output older than the measurement is not an answer to it. */
  test("test_does_not_report_output_that_predates_the_request", async () => {
    const metrics = _metrics();
    const start = time();
    await metrics.startTtfbMetrics({ startTime: start, reportOnlyInitialTtfb: false });

    expect(await metrics.stopTtfbMetrics({ endTime: start - 0.3 })).toBeNull();
  });

  /**
   * The refused measurement is closed, not left open for a later stop.
   *
   * Otherwise the next output to arrive would be measured against a start
   * time that has already been rejected once.
   */
  test("test_a_refused_measurement_does_not_linger", async () => {
    const metrics = _metrics();
    const start = time();
    await metrics.startTtfbMetrics({ startTime: start, reportOnlyInitialTtfb: false });

    await metrics.stopTtfbMetrics({ endTime: start - 0.3 });

    expect(await metrics.stopTtfbMetrics({ endTime: start + 0.5 })).toBeNull();
  });

  /** Stopping without a start is a no-op. */
  test("test_reports_nothing_when_no_measurement_is_running", async () => {
    expect(await _metrics().stopTtfbMetrics()).toBeNull();
  });
});

/** Test view of the protected members the upstream tests poke at. */
interface StubSTTInternals {
  _sttTtfbTimeout: number;
  _lastTranscriptTime: number;
  _metrics: { _startTtfbTime: number };
  _ttfbTimeoutHandler(): Promise<void>;
}

function makeService() {
  class _StubSTT extends STTService {
    override canGenerateMetrics(): boolean {
      return true;
    }

    override get metricsEnabled(): boolean {
      // Enabled by pipeline setup, which these tests bypass. Without
      // it every measurement call is a no-op and the assertions here
      // hold for the wrong reason.
      return true;
    }

    async *runStt(_audio: Uint8Array): AsyncGenerator<Frame | null, void, unknown> {}
  }

  const service = new _StubSTT();
  const internals = service as unknown as StubSTTInternals;
  internals._sttTtfbTimeout = 0.0;
  const stopTtfbMetrics = mock(async (_options?: { endTime?: number | null }) => {});
  service.stopTtfbMetrics = stopTtfbMetrics;
  return { service, internals, stopTtfbMetrics };
}

describe("TestSTTTTFBTimeout", () => {
  let fixture: ReturnType<typeof makeService>;

  beforeEach(() => {
    fixture = makeService();
  });

  /** The transcript that arrived is what TTFB measures to. */
  test("test_measures_to_the_last_transcript", async () => {
    const { internals, stopTtfbMetrics } = fixture;
    internals._lastTranscriptTime = 1000.4;

    await internals._ttfbTimeoutHandler();

    expect(stopTtfbMetrics).toHaveBeenCalledTimes(1);
    expect(stopTtfbMetrics).toHaveBeenCalledWith({ endTime: 1000.4 });
  });

  /**
   * A transcript the service finalized earlier is not this utterance's.
   *
   * The service finalized an earlier segment on its own endpointing, and no
   * transcript arrived for the final segment at all. Measuring to it is
   * refused where the speech end time lives, rather than compared again
   * here.
   */
  test("test_a_transcript_from_before_speech_ended_reports_nothing", async () => {
    const { service, internals } = fixture;
    service.stopTtfbMetrics = STTService.prototype.stopTtfbMetrics.bind(service);
    const pushFrame = mock(async (_frame: Frame) => {});
    service.pushFrame = pushFrame;
    await service.startTtfbMetrics({ startTime: 1000.0 });
    expect(internals._metrics._startTtfbTime).toEqual(1000.0);
    internals._lastTranscriptTime = 999.6;

    await internals._ttfbTimeoutHandler();

    expect(pushFrame).not.toHaveBeenCalled();
    expect(internals._metrics._startTtfbTime).toEqual(0);
  });

  /** No transcript since the last VAD start means nothing to measure. */
  test("test_an_utterance_with_no_transcript_at_all_reports_nothing", async () => {
    const { internals, stopTtfbMetrics } = fixture;
    internals._lastTranscriptTime = 0;

    await internals._ttfbTimeoutHandler();

    expect(stopTtfbMetrics).not.toHaveBeenCalled();
  });

  /**
   * An abandoned utterance cannot be measured against later.
   *
   * Leaving it open would let the next transcript -- which the service may
   * finalize on its own before the next VAD stop -- be measured from the
   * speech end of an utterance that never got an answer, reporting a large
   * and entirely fictional latency.
   */
  test("test_an_utterance_with_no_transcript_closes_the_measurement", async () => {
    const { service, internals } = fixture;
    await service.startTtfbMetrics({ startTime: 1000.0 });
    expect(internals._metrics._startTtfbTime).toEqual(1000.0);
    internals._lastTranscriptTime = 0;

    await internals._ttfbTimeoutHandler();

    expect(internals._metrics._startTtfbTime).toEqual(0);
  });
});
