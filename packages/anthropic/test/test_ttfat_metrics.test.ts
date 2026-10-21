// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_ttfat_metrics.py

/**
 * Tests for time-to-first-answer-token (TTFAT) metrics.
 *
 * PORTING NOTES:
 * - `patch.object(service, name, fake)` → the fake is assigned on the instance
 *   and the original restored afterwards.
 * - `pytest.approx(x, abs=e)` → `Math.abs(a - x) <= e`; bare `pytest.approx(x)`
 *   (relative 1e-6) → `toBeCloseTo`.
 * - Google chunks are built as plain objects with the JS SDK's camelCase field
 *   names instead of the google-genai pydantic models; the service only reads
 *   those fields. Anthropic `SimpleNamespace` events are plain objects.
 * - Google services are imported by relative path from `@pipedog/google`,
 *   which this package does not depend on.
 * - `frame_processor_setup` (tests/frame_processor_helpers.py) is ported locally.
 */

import { describe, expect, mock, test } from "bun:test";
import { time } from "@pipedog/asyncio";
import { SystemClock } from "@pipedog/core/clocks/system_clock";
import { MetricsFrame } from "@pipedog/core/frames/frames";
import { TTFATMetricsData, TTFBMetricsData } from "@pipedog/core/metrics/metrics";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "@pipedog/core/processors/frame_processor";
import { FrameProcessorMetrics } from "@pipedog/core/processors/metrics/frame_processor_metrics";
import { type BaseTaskManager, TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { GeminiLiveLLMService } from "../../google/src/gemini_live/llm.ts";
import { GoogleLLMService } from "../../google/src/llm.ts";
import { AnthropicLLMService } from "../src/llm.ts";

type Internals = any;
type PatchStream = (service: Internals, generator: () => AsyncGenerator<unknown>) => () => void;

/** Assign `value` to `obj[name]`, returning a function that restores it. */
function patchObject(obj: Internals, name: string, value: unknown): () => void {
  const had = Object.hasOwn(obj, name);
  const original = obj[name];
  obj[name] = value;
  return () => {
    if (had) {
      obj[name] = original;
    } else {
      delete obj[name];
    }
  };
}

/** Run `fn` with the patches applied, restoring them afterwards. */
async function withPatches<T>(restores: (() => void)[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    for (const restore of restores.reverse()) {
      restore();
    }
  }
}

/** `assert value == pytest.approx(expected, abs=tol)`. */
function expectApprox(value: number, expected: number, tol: number): void {
  expect(Math.abs(value - expected)).toBeLessThanOrEqual(tol);
}

/** Local port of upstream tests/frame_processor_helpers.py `frame_processor_setup`. */
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

/** A streamed chunk carrying model output. */
function _googleChunk(text: string): Record<string, unknown> {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
  };
}

/** A streamed chunk carrying a tool call. */
function _googleChunkWithFunctionCall(name: string): Record<string, unknown> {
  return {
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args: {} } }] } }],
  };
}

/** TTFAT measurement in the metrics collector. */
describe("TestTTFATMetrics", () => {
  function _makeMetrics(): FrameProcessorMetrics {
    const m = new FrameProcessorMetrics();
    m.setProcessorName("TestLLM");
    return m;
  }

  /** Run a TTFB measurement of `ttfb` seconds, which arms TTFAT. */
  async function _measureTtfb(
    m: FrameProcessorMetrics,
    start: number,
    ttfb: number,
    { reportOnlyInitialTtfb = false }: { reportOnlyInitialTtfb?: boolean } = {},
  ): Promise<void> {
    await m.startTtfbMetrics({ startTime: start, reportOnlyInitialTtfb });
    await m.stopTtfbMetrics({ endTime: start + ttfb });
  }

  test("test_ttfat_carries_breakdown", async () => {
    const m = _makeMetrics();
    const start = time();
    await _measureTtfb(m, start, 0.2);

    const frame = await m.stopTtfatMetrics({ endTime: start + 0.9 });
    expect(frame).not.toBeNull();
    const data = frame!.data[0] as TTFATMetricsData;
    expect(data).toBeInstanceOf(TTFATMetricsData);
    expectApprox(data.ttfat, 0.9, 1e-3);
    expectApprox(data.ttfb, 0.2, 1e-3);
    expectApprox(data.thinkingTime, 0.7, 1e-3);
    expect(data.ttfat).toBeCloseTo(data.ttfb + data.thinkingTime, 6);
  });

  /** The two measurements share a start, so TTFAT is never the gap alone. */
  test("test_ttfat_measures_from_the_request_not_from_ttfb", async () => {
    const m = _makeMetrics();
    const start = time();
    await _measureTtfb(m, start, 0.5);

    const frame = await m.stopTtfatMetrics({ endTime: start + 0.6 });
    expect(frame).not.toBeNull();
    const data = frame!.data[0] as TTFATMetricsData;
    expectApprox(data.ttfat, 0.6, 1e-3);
    expectApprox(data.thinkingTime, 0.1, 1e-3);
  });

  test("test_answer_token_arriving_with_first_output_reports_no_thinking", async () => {
    const m = _makeMetrics();
    const start = time();
    await _measureTtfb(m, start, 0.3);

    const frame = await m.stopTtfatMetrics({ endTime: start + 0.3 });
    expect(frame).not.toBeNull();
    expectApprox((frame!.data[0] as TTFATMetricsData).thinkingTime, 0.0, 1e-3);
  });

  test("test_ttfat_reported_once_per_response", async () => {
    const m = _makeMetrics();
    const start = time();
    await _measureTtfb(m, start, 0.1);

    expect(await m.stopTtfatMetrics({ endTime: start + 0.4 })).not.toBeNull();
    // Later tokens in the same response do not re-report.
    expect(await m.stopTtfatMetrics({ endTime: start + 0.5 })).toBeNull();
  });

  /** Nothing arms TTFAT if the response produced no output at all. */
  test("test_no_metric_without_ttfb", async () => {
    const m = _makeMetrics();
    expect(await m.stopTtfatMetrics({ endTime: time() })).toBeNull();
  });

  /** A response cut off before its answer token reports nothing. */
  test("test_interrupted_response_does_not_leak_into_the_next", async () => {
    const m = _makeMetrics();
    const first = time();
    await _measureTtfb(m, first, 0.2);
    // No answer token arrives; the next request starts instead.
    const second = first + 10.0;
    await _measureTtfb(m, second, 0.3);

    const frame = await m.stopTtfatMetrics({ endTime: second + 0.8 });
    expect(frame).not.toBeNull();
    const data = frame!.data[0] as TTFATMetricsData;
    // Measured against the second request, not the abandoned first.
    expectApprox(data.ttfat, 0.8, 1e-3);
    expectApprox(data.thinkingTime, 0.5, 1e-3);
  });

  /** `reportOnlyInitialTtfb` stops later requests measuring anything at all. */
  test("test_interrupted_response_does_not_leak_when_reporting_only_initial_ttfb", async () => {
    const m = _makeMetrics();
    const first = time();
    await _measureTtfb(m, first, 0.2, { reportOnlyInitialTtfb: true });
    // No answer token arrives; the next request starts instead. Its TTFB
    // goes unmeasured, so there is no request start to measure TTFAT from.
    const second = first + 10.0;
    await _measureTtfb(m, second, 0.3, { reportOnlyInitialTtfb: true });

    expect(await m.stopTtfatMetrics({ endTime: second + 0.8 })).toBeNull();
  });
});

/** Which services report TTFAT, and when they record it. */
describe("TestTTFATServiceReporting", () => {
  test("test_text_service_reports_ttfat", () => {
    expect(new GoogleLLMService({ apiKey: "test-key" }).reportsTtfat).toBe(true);
  });

  test("test_speech_to_speech_service_does_not_report_ttfat", () => {
    expect(new GeminiLiveLLMService({ apiKey: "test-key" }).reportsTtfat).toBe(false);
  });

  /**
   * The measurement belongs to the model, not to what the pipeline does next.
   *
   * Turn-completion filtering can hold a response's text back or drop it, so
   * recording TTFAT downstream of that would time the filter instead.
   */
  test("test_recorded_even_when_turn_completion_withholds_the_text", async () => {
    const service: Internals = new GoogleLLMService({ apiKey: "test-key" });
    service._filterIncompleteUserTurns = true;
    // State in which _pushTurnText drops the text outright.
    service._userTurnCompletionVoiced = true;
    service._turnMarker = null;

    const recorded: boolean[] = [];
    const pushed: unknown[] = [];

    async function fakeStopTtfat(..._args: unknown[]): Promise<void> {
      recorded.push(true);
    }

    async function captureFrame(frame: unknown, _direction?: unknown): Promise<void> {
      pushed.push(frame);
    }

    await withPatches(
      [
        patchObject(service, "stopTtfatMetrics", fakeStopTtfat),
        patchObject(service, "pushFrame", captureFrame),
      ],
      () => service._pushLlmText("Hello"),
    );

    // TTFAT should be recorded when the model produces the token
    expect(recorded.length).toBeGreaterThan(0);
    // no text reaches the pipeline in this state
    expect(pushed).toHaveLength(0);
  });

  /** The full path: a streamed response emits TTFAT alongside TTFB. */
  test("test_streamed_response_pushes_a_ttfat_frame", async () => {
    const service: Internals = new GoogleLLMService({ apiKey: "test-key" });
    await service.setup(frameProcessorSetup(new TaskManager(), { enableMetrics: true }));

    const frames: unknown[] = [];

    async function captureFrame(frame: unknown, _direction?: unknown): Promise<void> {
      frames.push(frame);
    }

    async function fakeStream(_context: unknown, ..._rest: unknown[]) {
      async function* generator(): AsyncGenerator<unknown> {
        yield _googleChunk("Hello");
      }
      return generator();
    }

    await withPatches(
      [
        patchObject(service, "pushFrame", captureFrame),
        patchObject(service, "_streamContent", fakeStream),
      ],
      () => service._processContext(new LLMContext()),
    );

    const metrics = frames.flatMap((f) => (f instanceof MetricsFrame ? f.data : []));
    const ttfat = metrics.filter((d) => d instanceof TTFATMetricsData) as TTFATMetricsData[];
    const ttfb = metrics.filter((d) => d instanceof TTFBMetricsData);
    // TTFB is still reported on its own
    expect(ttfb).toHaveLength(1);
    // TTFAT is reported once for the response
    expect(ttfat).toHaveLength(1);
    expect(ttfat[0]!.ttfat).toBeGreaterThanOrEqual(ttfat[0]!.ttfb);
    expect(ttfat[0]!.thinkingTime).toBeCloseTo(ttfat[0]!.ttfat - ttfat[0]!.ttfb, 6);
  });
});

/** A tool-only turn ends TTFAT at its first tool call, not at end of stream. */
describe("TestTTFATToolCalls", () => {
  /** Stream canned chunks and report which one ended TTFAT. */
  async function _stopIndex(
    service: Internals,
    patchStream: PatchStream,
    chunks: unknown[],
  ): Promise<number | null> {
    const state: { index: number; stoppedAt: number | null } = { index: -1, stoppedAt: null };

    async function fakeStopTtfat(..._args: unknown[]): Promise<void> {
      if (state.stoppedAt === null) {
        state.stoppedAt = state.index;
      }
    }

    async function* generator(): AsyncGenerator<unknown> {
      for (const [index, chunk] of chunks.entries()) {
        state.index = index;
        yield chunk;
      }
    }

    async function captureFrame(_frame: unknown, _direction?: unknown): Promise<void> {}

    await withPatches(
      [
        patchObject(service, "pushFrame", captureFrame),
        patchObject(service, "stopTtfatMetrics", fakeStopTtfat),
        patchObject(
          service,
          "runFunctionCalls",
          mock(async () => {}),
        ),
        patchStream(service, generator),
      ],
      () => service._processContext(new LLMContext()),
    );

    return state.stoppedAt;
  }

  function _googlePatchStream(svc: Internals, generator: () => AsyncGenerator<unknown>) {
    async function fakeStream(_context: unknown, ..._rest: unknown[]) {
      return generator();
    }

    return patchObject(svc, "_streamContent", fakeStream);
  }

  test("test_google_stops_at_the_tool_call_not_end_of_stream", async () => {
    const service = new GoogleLLMService({ apiKey: "test-key" });

    const chunks = [
      _googleChunkWithFunctionCall("get_weather"),
      // Trailing chunks the model streams before the response ends.
      _googleChunk(""),
      _googleChunk(""),
    ];
    expect(await _stopIndex(service, _googlePatchStream, chunks)).toBe(0);
  });

  test("test_anthropic_stops_at_the_tool_call_not_end_of_stream", async () => {
    const service = new AnthropicLLMService({ apiKey: "test-key" });

    function patchStream(svc: Internals, generator: () => AsyncGenerator<unknown>) {
      async function fakeStream(_apiCall: unknown, _params: unknown) {
        return generator();
      }

      return patchObject(svc, "_createMessageStream", fakeStream);
    }

    const events = [
      { type: "message_start", message: { usage: null } },
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "t1", name: "get_weather" },
      },
      // Arguments stream after the call begins; TTFAT must not wait for them.
      { type: "content_block_delta", delta: { partial_json: '{"city":' } },
      { type: "content_block_delta", delta: { partial_json: '"Paris"}' } },
    ];
    expect(await _stopIndex(service, patchStream, events)).toBe(1);
  });

  /** Text and tool calls share one measurement; whichever comes first ends it. */
  test("test_answer_text_before_a_tool_call_wins", async () => {
    const service = new GoogleLLMService({ apiKey: "test-key" });

    const chunks = [
      _googleChunk("Let me look that up."),
      _googleChunkWithFunctionCall("get_weather"),
    ];
    expect(await _stopIndex(service, _googlePatchStream, chunks)).toBe(0);
  });
});
