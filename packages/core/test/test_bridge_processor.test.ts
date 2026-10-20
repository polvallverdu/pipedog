// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_bridge_processor.py

import { describe, expect, test } from "bun:test";
import { Event, gather, sleep, waitFor } from "@pipecat-ts/asyncio";
import {
  AsyncQueueBus,
  BusBridgeProcessor,
  BusFrameMessage,
  type BusMessage,
} from "../src/bus/index.ts";
import { EndFrame, type Frame, TextFrame } from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { PipelineWorker } from "../src/pipeline/worker.ts";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../src/processors/frame_processor.ts";
import { runTest } from "../src/tests/utils.ts";
import { WorkerRunner } from "../src/workers/runner.ts";

/** Wrap `bus.send` so every sent message is also recorded in the returned list. */
function captureSend(bus: AsyncQueueBus): BusMessage[] {
  const sentToBus: BusMessage[] = [];
  const originalSend = bus.send.bind(bus);
  bus.send = async (msg: BusMessage) => {
    sentToBus.push(msg);
    await originalSend(msg);
  };
  return sentToBus;
}

/** Wrap `processor.pushFrame` so every pushed frame is also recorded in the returned list. */
function capturePush(processor: FrameProcessor): Frame[] {
  const injected: Frame[] = [];
  const originalPush = processor.pushFrame.bind(processor);
  processor.pushFrame = async (
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ) => {
    injected.push(frame);
    await originalPush(frame, direction);
  };
  return injected;
}

describe("TestBusBridgeProcessor", () => {
  test("test_frames_sent_to_bus_not_passed_through", async () => {
    // Non-lifecycle frames are sent to the bus, not passed through.
    const bus = new AsyncQueueBus();
    const sentToBus = captureSend(bus);

    const processor = new BusBridgeProcessor({
      bus,
      workerName: "test_task",
    });
    const pipeline = new Pipeline([processor]);

    const framesToSend = [new TextFrame({ text: "hello" })];

    const [down] = await runTest(pipeline, {
      framesToSend,
      expectedDownFrames: [],
    });

    // Frame NOT passed through downstream
    const textFrames = down.filter((f) => f instanceof TextFrame);
    expect(textFrames.length).toEqual(0);

    // Frame sent to bus
    const busFrameMsgs = sentToBus.filter((m) => m instanceof BusFrameMessage);
    expect(busFrameMsgs.length).toEqual(1);
    expect((busFrameMsgs[0]!.frame as TextFrame).text).toEqual("hello");
    expect(busFrameMsgs[0]!.source).toEqual("test_task");
    expect(busFrameMsgs[0]!.direction).toEqual(FrameDirection.DOWNSTREAM);
  });

  test("test_lifecycle_frames_pass_through_not_sent_to_bus", async () => {
    // Lifecycle frames pass through but are never sent to the bus.
    const bus = new AsyncQueueBus();
    const sentToBus = captureSend(bus);

    const processor = new BusBridgeProcessor({
      bus,
      workerName: "test_task",
    });
    const pipeline = new Pipeline([processor]);

    // runTest sends StartFrame + framesToSend + EndFrame
    // TextFrame goes to bus (not downstream), lifecycle frames pass through
    const framesToSend = [new TextFrame({ text: "hello" })];
    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames: [],
    });

    const busFrameMsgs = sentToBus.filter((m) => m instanceof BusFrameMessage);
    // Only the TextFrame, not StartFrame or EndFrame
    expect(busFrameMsgs.length).toEqual(1);
    expect(busFrameMsgs[0]!.frame).toBeInstanceOf(TextFrame);
  });

  test("test_exclude_frames_not_sent_to_bus", async () => {
    // Excluded frame types pass through but are not sent to the bus.
    const bus = new AsyncQueueBus();
    const sentToBus = captureSend(bus);

    const processor = new BusBridgeProcessor({
      bus,
      workerName: "test_task",
      excludeFrames: [TextFrame],
    });
    const pipeline = new Pipeline([processor]);

    const framesToSend = [new TextFrame({ text: "excluded" })];
    const expectedDownFrames = [TextFrame];

    const [down] = await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
    });

    // Frame passed through
    expect(down.length).toEqual(1);
    expect((down[0] as TextFrame).text).toEqual("excluded");

    // But NOT sent to bus
    const busFrameMsgs = sentToBus.filter((m) => m instanceof BusFrameMessage);
    expect(busFrameMsgs.length).toEqual(0);
  });

  test("test_bus_frame_injected_at_bridge", async () => {
    // Frames from the bus are injected at the bridge position and travel
    // downstream alongside frames from later pipeline processors.

    /** Appends a TextFrame for every TextFrame it sees. */
    class AppendFrameProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        await this.pushFrame(frame, direction);
        if (frame instanceof TextFrame) {
          await this.pushFrame(new TextFrame({ text: "after_bridge" }), direction);
        }
      }
    }

    const bus = new AsyncQueueBus();
    const bridge = new BusBridgeProcessor({
      bus,
      workerName: "main_task",
    });
    const pipeline = new Pipeline([bridge, new AppendFrameProcessor()]);
    const worker = new PipelineWorker(pipeline, { cancelOnIdleTimeout: false });

    const received: Frame[] = [];
    worker.setReachedDownstreamFilter([TextFrame]);

    worker.eventHandler("on_frame_reached_downstream", async (_worker: unknown, frame: Frame) => {
      received.push(frame);
    });

    const msg = new BusFrameMessage({
      source: "child_task",
      frame: new TextFrame({ text: "from_child" }),
      direction: FrameDirection.DOWNSTREAM,
    });

    const injectAndEnd = async () => {
      await sleep(0.02);
      await bridge.onBusMessage(msg);
      await sleep(0.02);
      await worker.queueFrame(new EndFrame());
    };

    const runner = new WorkerRunner();
    await runner.addWorkers(worker);
    await gather(runner.run(), injectAndEnd());

    const texts = received.filter((f) => f instanceof TextFrame).map((f) => (f as TextFrame).text);
    expect(texts).toContain("from_child");
    expect(texts).toContain("after_bridge");
  });

  test("test_skips_own_frames", async () => {
    // Bridge ignores bus frames from its own worker.
    const bus = new AsyncQueueBus();
    const processor = new BusBridgeProcessor({
      bus,
      workerName: "test_task",
    });

    const injected = capturePush(processor);

    // Own frame should be ignored
    const msg = new BusFrameMessage({
      source: "test_task",
      frame: new TextFrame({ text: "self" }),
      direction: FrameDirection.DOWNSTREAM,
    });
    await processor.onBusMessage(msg);

    // Should not have injected anything
    expect(injected.length).toEqual(0);
  });

  // The deprecated `target_task` parameter is not ported (use `targetWorker`).
  test.skip("test_target_task_filtering", () => {
    // Deprecated-only: exercises `BusBridgeProcessor(target_task=...)`, which is
    // deprecated upstream since 1.8.0 and therefore not ported.
  });

  test("test_targeted_message_for_other_task_skipped", async () => {
    // Bridge skips bus messages targeted at a different worker.
    const bus = new AsyncQueueBus();
    const processor = new BusBridgeProcessor({
      bus,
      workerName: "main_task",
    });

    const injected = capturePush(processor);

    const msg = new BusFrameMessage({
      source: "child",
      target: "other_task",
      frame: new TextFrame({ text: "not_for_me" }),
      direction: FrameDirection.DOWNSTREAM,
    });
    await processor.onBusMessage(msg);
    expect(injected.length).toEqual(0);
  });
});

describe("TestBusEdgeProcessorOrdering", () => {
  // Frames received from the bus by `_BusEdgeProcessor.onBusMessage` are
  // serialised with frames the owning worker queues via
  // `queueFrame`/`queueFrames`, so a bus inbound frame cannot interleave
  // between a multi-frame sequence the worker enqueues itself (regression
  // test for the multi-worker `set_node` apply race where an
  // `LLMContextFrame` from a user input would reach the LLM before the new
  // node's `LLMSetToolsFrame` had landed).

  test("test_bus_inbound_drains_after_worker_queued_frames", async () => {
    // A frame received from the bus is observed downstream **after** any
    // frames queued via `worker.queueFrame` before it, because both paths
    // share the worker's single push queue (FIFO).

    interface RecordingProcessorOptions extends FrameProcessorOptions {
      observed: string[];
    }

    /** Appends every `TextFrame` it sees to a shared list. */
    class RecordingProcessor extends FrameProcessor {
      #observed: string[];

      constructor(options: RecordingProcessorOptions) {
        super(options);
        this.#observed = options.observed;
      }

      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof TextFrame) {
          this.#observed.push(frame.text);
        }
        await this.pushFrame(frame, direction);
      }
    }

    const observed: string[] = [];
    const bus = new AsyncQueueBus();
    const recorder = new RecordingProcessor({ observed });
    // `bridged: []` wraps the pipeline with _BusEdgeProcessor at both ends so
    // frames received from the bus are injected here.
    const worker = new PipelineWorker(new Pipeline([recorder]), {
      cancelOnIdleTimeout: false,
      bridged: [],
    });

    const ready = new Event();

    worker.eventHandler("on_pipeline_started", async (_w: unknown, _f: unknown) => {
      ready.set();
    });

    const drive = async () => {
      await waitFor(ready.wait(), 5);
      // Queue an APPLY-like frame on the worker FIRST, then push a bus
      // message. If the bus path bypassed the queue (the old behaviour), the
      // bus frame could race ahead and be observed before "apply". With this
      // fix it is queued and drains after.
      await worker.queueFrame(new TextFrame({ text: "apply" }));
      await bus.send(
        new BusFrameMessage({
          source: "other_task",
          frame: new TextFrame({ text: "from_bus" }),
          direction: FrameDirection.DOWNSTREAM,
        }),
      );
      await sleep(0.2);
      await worker.queueFrame(new EndFrame());
    };

    const runner = new WorkerRunner({ bus, handleSigint: false });
    await runner.addWorkers(worker);
    await gather(runner.run(), drive());

    // The bus inbound frame must NEVER precede the previously queued apply
    // frame. "apply" is queued first; "from_bus" arrives via onBusMessage
    // after that put. Both frames land in the same push queue and drain
    // FIFO, so the order observed downstream is deterministic.
    const applyIdx = observed.indexOf("apply");
    const busIdx = observed.indexOf("from_bus");
    expect(applyIdx, `apply missing from ${observed}`).toBeGreaterThanOrEqual(0);
    expect(busIdx, `from_bus missing from ${observed}`).toBeGreaterThanOrEqual(0);
    expect(
      applyIdx,
      `bus inbound 'from_bus' raced ahead of locally queued 'apply' (observed order: ${observed})`,
    ).toBeLessThan(busIdx);
  });
});
