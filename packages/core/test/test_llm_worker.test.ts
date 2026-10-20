// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_worker.py

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createTask, Event, sleep } from "@pipecat-ts/asyncio";
import { type Frame, LLMMessagesAppendFrame, PipelineFlushFrame } from "../src/frames/frames.ts";
import { PipelineWorker } from "../src/pipeline/worker.ts";
import { FrameDirection, FrameProcessor } from "../src/processors/frame_processor.ts";
import type { FunctionCallParams, LLMService } from "../src/services/llm_service.ts";
import { LLMWorker } from "../src/workers/llm/llm_worker.ts";
import { type LLMTool, tool } from "../src/workers/llm/tool_decorator.ts";

type Delivered = [Frame, FrameDirection];

/** Stands in for Python's ValueError. */
class ValueError extends Error {}

/** Test access to the worker's protected members (Python reads them directly). */
class StubLLMWorker extends LLMWorker {
  _deliveredFrames: Delivered[] = [];
  _restorePtQueueFrame: (() => void) | null = null;

  /** A quick tool. */
  async fast_tool(params: FunctionCallParams): Promise<void> {
    await params.resultCallback("done");
  }

  /** A tool that blocks on an event for coordination. */
  async slow_tool(params: FunctionCallParams, _delay: number): Promise<void> {
    await params.resultCallback("done");
  }

  static {
    // biome-ignore lint/complexity/noThisInStatic: decorates this class's own methods.
    tool(this.prototype.fast_tool);
    // biome-ignore lint/complexity/noThisInStatic: decorates this class's own methods.
    tool(this.prototype.slow_tool);
  }

  get deferredFrames(): [Frame, FrameDirection][] {
    return this._deferredFrames;
  }

  get toolCallInflight(): number {
    return this._toolCallInflight;
  }

  set toolCallInflight(value: number) {
    this._toolCallInflight = value;
  }

  trackToolCall(method: LLMTool): (params: FunctionCallParams) => Promise<void> {
    return this._trackToolCall(method);
  }
}

/** Create a StubLLMWorker with mocked parent queueFrame for testing. */
function _createWorker(): StubLLMWorker {
  const llm = new FrameProcessor() as unknown as LLMService & { registerFunction: unknown };
  llm.registerFunction = mock();
  const worker = new StubLLMWorker({ name: "test_worker", llm, bridged: [] });

  // Capture frames passed to PipelineWorker.queueFrame (i.e. super.queueFrame).
  const delivered: Delivered[] = [];
  const originalPtQueueFrame = PipelineWorker.prototype.queueFrame;

  PipelineWorker.prototype.queueFrame = async function (
    this: PipelineWorker,
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    // Only intercept for this specific instance; otherwise fall through.
    if (this === worker) {
      delivered.push([frame, direction]);
      return;
    }
    await originalPtQueueFrame.call(this, frame, direction);
  };

  // flushPipeline() does a real round-trip through the pipeline source/sink,
  // which this stubbed worker has no running pipeline to service. Complete it
  // instantly so the deferral logic under test isn't blocked on the probe.
  worker.flushPipeline = async (_timeout?: number): Promise<boolean> => true;
  worker._restorePtQueueFrame = () => {
    PipelineWorker.prototype.queueFrame = originalPtQueueFrame;
  };

  worker._deliveredFrames = delivered;
  return worker;
}

/** Extract non-flush frames delivered to the underlying pipeline. */
function _getDeliveredFrames(worker: StubLLMWorker): Delivered[] {
  return worker._deliveredFrames.filter(([frame]) => !(frame instanceof PipelineFlushFrame));
}

function _makeFrame(content: string, runLlm = true): LLMMessagesAppendFrame {
  return new LLMMessagesAppendFrame({ messages: [{ role: "user", content }], runLlm });
}

const magicMock = (): any => ({});

describe("TestToolCallTracking", () => {
  let workers: StubLLMWorker[] = [];

  const track = (worker: StubLLMWorker): StubLLMWorker => {
    workers.push(worker);
    return worker;
  };

  beforeEach(() => {
    workers = [];
  });

  afterEach(() => {
    // Restore in reverse so the original prototype method ends up in place.
    for (const worker of [...workers].reverse()) {
      worker._restorePtQueueFrame?.();
    }
  });

  test("test_tool_call_active_initially_false", async () => {
    const worker = track(_createWorker());
    expect(worker.toolCallActive).toBe(false);
  });

  test("test_tool_call_active_during_execution", async () => {
    // tool_call_active is True while a tool is running.
    const worker = track(_createWorker());
    const observed: boolean[] = [];

    /** Waits on gate. */
    const gated_tool = tool(async function gated_tool(this: LLMWorker, params: unknown) {
      void params;
      observed.push(worker.toolCallActive);
    });

    const wrapped = worker.trackToolCall(gated_tool);
    const params = magicMock();
    await wrapped(params);

    expect(observed[0]).toBe(true);
    expect(worker.toolCallActive).toBe(false);
  });

  test("test_queue_frame_delivers_immediately_when_idle", async () => {
    // queue_frame delivers immediately when no tools are in-flight.
    const worker = track(_createWorker());
    const frame = _makeFrame("hello");

    await worker.queueFrame(frame);

    const delivered = _getDeliveredFrames(worker);
    expect(delivered.length).toBe(1);
    expect(delivered[0]?.[0]).toBe(frame);
  });

  test("test_queue_frame_defers_a_frame_the_tool_queued", async () => {
    // A frame queued from inside a tool handler is held.
    const worker = track(_createWorker());
    const frame = _makeFrame("deferred");
    const gate = new Event();

    /** Queues a frame, then blocks. */
    const queueing_tool = tool(async function queueing_tool(this: LLMWorker, params: unknown) {
      void params;
      await worker.queueFrame(frame);
      await gate.wait();
    });

    const wrapped = worker.trackToolCall(queueing_tool);
    const runnerTask = createTask(() => wrapped(magicMock()));
    await sleep(0);

    expect(_getDeliveredFrames(worker).length).toBe(0);
    expect([...worker.deferredFrames]).toEqual([[frame, FrameDirection.DOWNSTREAM]]);

    gate.set();
    await runnerTask;
  });

  test("test_a_tool_does_not_defer_on_another_worker", async () => {
    // Only the worker running the tool holds what its handler queues.
    //
    // A handler can reach another worker, and that worker would never
    // release a frame it held, since it has no tool of its own to finish.
    const worker = track(_createWorker());
    const other = track(_createWorker());
    const frame = _makeFrame("for the other worker");
    const gate = new Event();

    /** Queues onto another worker, then blocks. */
    const reaching_tool = tool(async function reaching_tool(this: LLMWorker, params: unknown) {
      void params;
      await other.queueFrame(frame);
      await gate.wait();
    });

    const wrapped = worker.trackToolCall(reaching_tool);
    const runnerTask = createTask(() => wrapped(magicMock()));
    await sleep(0);

    expect(other.deferredFrames.length).toBe(0);
    expect(_getDeliveredFrames(other).length).toBe(1);

    gate.set();
    await runnerTask;
  });

  test("test_queue_frame_does_not_defer_traffic_from_elsewhere", async () => {
    // A tool running does not hold back frames from other sources.
    //
    // Bus traffic and the worker's own lifecycle frames arrive on other
    // tasks, outside the handler's context, and must not be caught by a
    // tool that happens to be running.
    const worker = track(_createWorker());
    const gate = new Event();

    /** Blocks until gate is set. */
    const blocking_tool = tool(async function blocking_tool(this: LLMWorker, params: unknown) {
      void params;
      await gate.wait();
    });

    const wrapped = worker.trackToolCall(blocking_tool);
    const runnerTask = createTask(() => wrapped(magicMock()));
    await sleep(0);
    expect(worker.toolCallInflight).toBe(1);

    const frame = _makeFrame("from elsewhere");
    await worker.queueFrame(frame);

    expect(worker.deferredFrames.length).toBe(0);
    expect(_getDeliveredFrames(worker).length).toBe(1);

    gate.set();
    await runnerTask;
  });

  test("test_deferred_frames_flush_when_tool_completes", async () => {
    // Frames deferred during a tool call are delivered when it finishes.
    const worker = track(_createWorker());
    const gate = new Event();
    const frame = _makeFrame("event data");

    /** Queues a frame, then blocks until gate is set. */
    const blocking_tool = tool(async function blocking_tool(this: LLMWorker, params: unknown) {
      void params;
      await worker.queueFrame(frame);
      await gate.wait();
    });

    const wrapped = worker.trackToolCall(blocking_tool);
    const params = magicMock();

    const runnerTask = createTask(() => wrapped(params));
    await sleep(0);

    expect(_getDeliveredFrames(worker).length).toBe(0);

    gate.set();
    await runnerTask;

    const delivered = _getDeliveredFrames(worker);
    expect(delivered.length).toBe(1);
    expect(delivered[0]?.[0]).toBe(frame);
  });

  test("test_concurrent_tools_flush_only_when_all_done", async () => {
    // With two parallel tools, flush happens only when the last one completes.
    const worker = track(_createWorker());
    const gateA = new Event();
    const gateB = new Event();

    /** Queues the frame, then blocks. */
    const tool_a = tool(async function tool_a(this: LLMWorker, params: unknown) {
      void params;
      await worker.queueFrame(frame);
      await gateA.wait();
    });

    /** Second tool. */
    const tool_b = tool(async function tool_b(this: LLMWorker, params: unknown) {
      void params;
      await gateB.wait();
    });

    const wrappedA = worker.trackToolCall(tool_a);
    const wrappedB = worker.trackToolCall(tool_b);
    const params = magicMock();

    const frame = _makeFrame("queued");
    const taskA = createTask(() => wrappedA(params));
    const taskB = createTask(() => wrappedB(params));
    await sleep(0);

    expect(worker.toolCallInflight).toBe(2);
    expect(_getDeliveredFrames(worker).length).toBe(0);

    // First tool finishes — frame still deferred (second tool running)
    gateA.set();
    await taskA;
    expect(worker.toolCallInflight).toBe(1);
    expect(_getDeliveredFrames(worker).length).toBe(0);

    // Second tool finishes — NOW flush
    gateB.set();
    await taskB;
    expect(worker.toolCallInflight).toBe(0);

    const delivered = _getDeliveredFrames(worker);
    expect(delivered.length).toBe(1);
    expect(delivered[0]?.[0]).toBe(frame);
  });

  test("test_queue_frame_preserves_frame_attributes", async () => {
    // Frame attributes like run_llm are preserved through defer and flush.
    const worker = track(_createWorker());
    const gate = new Event();

    /** Blocks. */
    const blocking_tool = tool(async function blocking_tool(this: LLMWorker, params: unknown) {
      void params;
      await gate.wait();
    });

    const wrapped = worker.trackToolCall(blocking_tool);
    const params = magicMock();

    const runnerTask = createTask(() => wrapped(params));
    await sleep(0);

    const frame = _makeFrame("no inference", false);
    await worker.queueFrame(frame);

    gate.set();
    await runnerTask;

    const delivered = _getDeliveredFrames(worker);
    expect(delivered.length).toBe(1);
    expect((delivered[0]?.[0] as LLMMessagesAppendFrame | undefined)?.runLlm).toBe(false);
  });

  test("test_multiple_deferred_frames_flush_in_order", async () => {
    // Multiple deferred frames are delivered in FIFO order.
    const worker = track(_createWorker());
    const gate = new Event();

    /** Blocks. */
    const blocking_tool = tool(async function blocking_tool(this: LLMWorker, params: unknown) {
      void params;
      await gate.wait();
    });

    const wrapped = worker.trackToolCall(blocking_tool);
    const params = magicMock();

    const runnerTask = createTask(() => wrapped(params));
    await sleep(0);

    const frameA = _makeFrame("first", false);
    const frameB = _makeFrame("second", true);
    await worker.queueFrame(frameA);
    await worker.queueFrame(frameB);

    gate.set();
    await runnerTask;

    const delivered = _getDeliveredFrames(worker);
    expect(delivered.length).toBe(2);
    expect(delivered[0]?.[0]).toBe(frameA);
    expect(delivered[1]?.[0]).toBe(frameB);
  });

  test("test_tool_error_still_decrements_and_flushes", async () => {
    // If a tool raises, the counter still decrements and deferred frames flush.
    const worker = track(_createWorker());

    /** Always fails. */
    const failing_tool = tool(async function failing_tool(this: LLMWorker, params: unknown) {
      void params;
      throw new ValueError("boom");
    });

    const wrapped = worker.trackToolCall(failing_tool);
    const params = magicMock();

    const frame = _makeFrame("recover");
    worker.toolCallInflight = 1;
    await worker.queueFrame(frame);
    worker.toolCallInflight = 0;

    await expect(wrapped(params)).rejects.toThrow(ValueError);

    expect(worker.toolCallActive).toBe(false);
    const delivered = _getDeliveredFrames(worker);
    expect(delivered.length).toBe(1);
    expect(delivered[0]?.[0]).toBe(frame);
  });
});
