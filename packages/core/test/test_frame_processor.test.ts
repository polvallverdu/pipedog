// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_frame_processor.py

import { describe, expect, mock, spyOn, test } from "bun:test";

import { createTask, Event, sleep, type Task, type TaskFn, waitFor } from "@pipedog/asyncio";

import { SystemClock } from "../src/clocks/system_clock.ts";
import {
  DataFrame,
  EndFrame,
  type Frame,
  InterruptionFrame,
  OutputTransportMessageUrgentFrame,
  StartFrame,
  StopFrame,
  SystemFrame,
  TextFrame,
  UserStartedSpeakingFrame,
} from "../src/frames/frames.ts";
import { Pipeline } from "../src/pipeline/pipeline.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import {
  FrameDirection,
  FrameProcessor,
  FrameProcessorSetup,
  type FrameProcessorSetupOptions,
} from "../src/processors/frame_processor.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import { type BaseTaskManager, TaskManager } from "../src/utils/asyncio/task_manager.ts";
import { ErrorCategory } from "../src/utils/errors.ts";
import { logger } from "../src/utils/logger.ts";

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

interface BroadcastTestFrameOptions {
  text?: string;
  value?: number;
  items?: string[];
}

/** Test frame with init fields for broadcast testing. */
class BroadcastTestFrame extends DataFrame {
  text: string;
  value: number;
  items: string[];

  constructor(options: BroadcastTestFrameOptions = {}) {
    super(options);
    this.text = options.text ?? "";
    this.value = options.value ?? 0;
    this.items = options.items ?? [];
  }
}

/** Captures BroadcastTestFrames travelling in one direction. */
class CaptureProcessor extends FrameProcessor {
  _captureList: Frame[];
  _captureDirection: FrameDirection;

  constructor(captureList: Frame[], direction: FrameDirection) {
    super();
    this._captureList = captureList;
    this._captureDirection = direction;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (direction === this._captureDirection && frame instanceof BroadcastTestFrame) {
      this._captureList.push(frame);
    }
    await this.pushFrame(frame, direction);
  }
}

interface _CancelInProgressFrameOptions {
  target?: Frame | null;
}

/** Asks the processor to cancel `target` if it is the frame in progress. */
class _CancelInProgressFrame extends SystemFrame {
  target: Frame | null;

  constructor(options: _CancelInProgressFrameOptions = {}) {
    super(options);
    this.target = options.target ?? null;
  }
}

/** Takes 0.4s over every non-system frame, and records what each cancel request did. */
class _CancelInProgressProcessor extends FrameProcessor {
  cancelled: boolean[] = [];

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof _CancelInProgressFrame) {
      expect(frame.target).not.toBeNull();
      this.cancelled.push(await this._cancelFrameInProgress(frame.target as Frame));
    } else if (!(frame instanceof SystemFrame)) {
      await sleep(0.4);
    }
    await this.pushFrame(frame, direction);
  }
}

describe("TestFrameProcessor", () => {
  test("test_before_after_events", async () => {
    const identity = new IdentityFilter();

    let beforeProcessCalled = false;
    let afterProcessCalled = false;
    let beforePushCalled = false;
    let afterPushCalled = false;

    identity.eventHandler("on_before_process_frame", async (_filter: unknown, _frame: Frame) => {
      beforeProcessCalled = true;
    });

    identity.eventHandler("on_after_process_frame", async (_filter: unknown, _frame: Frame) => {
      afterProcessCalled = true;
    });

    identity.eventHandler("on_before_push_frame", async (_filter: unknown, _frame: Frame) => {
      beforePushCalled = true;
    });

    identity.eventHandler("on_after_push_frame", async (_filter: unknown, _frame: Frame) => {
      afterPushCalled = true;
    });

    const pipeline = new Pipeline([identity]);

    const framesToSend = [new TextFrame({ text: "Hello cat!" })];

    const expectedDownFrames = [TextFrame];

    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
    });
    expect(beforeProcessCalled).toBe(true);
    expect(afterProcessCalled).toBe(true);
    expect(beforePushCalled).toBe(true);
    expect(afterPushCalled).toBe(true);
  });

  test("test_broadcast_interruption", async () => {
    // Test that broadcastInterruption() pushes InterruptionFrame both
    // directions and allows subsequent code to run.
    class InterruptFrameProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);

        if (frame instanceof TextFrame) {
          await this.broadcastInterruption();
          await this.pushFrame(new OutputTransportMessageUrgentFrame({ message: frame.text }));
        } else {
          await this.pushFrame(frame, direction);
        }
      }
    }

    const pipeline = new Pipeline([new InterruptFrameProcessor()]);

    const framesToSend = [
      new TextFrame({ text: "Hello from Pipecat!" }),
      new SleepFrame({ sleep: 0.5 }),
    ];
    const expectedDownFrames = [InterruptionFrame, OutputTransportMessageUrgentFrame];
    const expectedUpFrames = [InterruptionFrame];
    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
      expectedUpFrames,
    });
  });

  test("test_interruptible_frames", async () => {
    interface TestInterruptibleFrameOptions {
      text: string;
    }
    class TestInterruptibleFrame extends DataFrame {
      text: string;
      constructor(options: TestInterruptibleFrameOptions) {
        super(options);
        this.text = options.text;
      }
    }

    /**
     * This processor just delays processing frames so we have time to try to
     * interrupt them.
     */
    class DelayTestFrameProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (!(frame instanceof SystemFrame)) {
          // Sleep more than SleepFrame default.
          await sleep(0.4);
        }
        await this.pushFrame(frame, direction);
      }
    }

    const pipeline = new Pipeline([new DelayTestFrameProcessor()]);

    const framesToSend = [
      new TestInterruptibleFrame({ text: "Hello from Pipecat!" }),
      // Make sure we hit the DelayTestFrameProcessor first.
      new SleepFrame(),
      // Just a random interruption. This should cause the interruption of
      // TestInterruptibleFrame.
      new InterruptionFrame(),
    ];
    const expectedDownFrames = [InterruptionFrame];
    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
    });
  });

  test("test_uninterruptible_frames", async () => {
    interface TestUninterruptibleFrameOptions {
      text: string;
    }
    class TestUninterruptibleFrame extends DataFrame {
      text: string;
      override interruptible = false;
      constructor(options: TestUninterruptibleFrameOptions) {
        super(options);
        this.text = options.text;
      }
    }

    /**
     * This processor just delays processing non-InterruptionFrame so we have
     * time to try to interrupt them.
     */
    class DelayTestFrameProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (!(frame instanceof SystemFrame)) {
          // Sleep more than SleepFrame default.
          await sleep(0.4);
        }
        await this.pushFrame(frame, direction);
      }
    }

    const pipeline = new Pipeline([new DelayTestFrameProcessor()]);

    const framesToSend = [
      new TestUninterruptibleFrame({ text: "Hello from Pipecat!" }),
      // Make sure we hit the DelayTestFrameProcessor first.
      new SleepFrame(),
      // Just a random interruption. This should not cause the interruption
      // of TestUninterruptibleFrame.
      new InterruptionFrame(),
    ];
    const expectedDownFrames = [InterruptionFrame, TestUninterruptibleFrame];
    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
    });
  });

  test("test_cancel_frame_in_progress_keeps_the_queue", async () => {
    const processor = new _CancelInProgressProcessor();
    const inProgress = new TextFrame({ text: "in progress" });
    const framesToSend = [
      inProgress,
      new SleepFrame({ sleep: 0.1 }),
      new TextFrame({ text: "queued" }),
      new _CancelInProgressFrame({ target: inProgress }),
    ];
    const [down] = await runTest(processor, {
      framesToSend,
      expectedDownFrames: [_CancelInProgressFrame, TextFrame],
    });
    expect(processor.cancelled).toEqual([true]);
    expect((down[down.length - 1] as TextFrame).text).toBe("queued");
  });

  test("test_cancel_frame_in_progress_leaves_other_frames_alone", async () => {
    const processor = new _CancelInProgressProcessor();
    const queued = new TextFrame({ text: "queued" });
    const framesToSend = [
      new TextFrame({ text: "in progress" }),
      new SleepFrame({ sleep: 0.1 }),
      queued,
      new _CancelInProgressFrame({ target: queued }),
    ];
    const [down] = await runTest(processor, {
      framesToSend,
      expectedDownFrames: [_CancelInProgressFrame, TextFrame, TextFrame],
    });
    expect(processor.cancelled).toEqual([false]);
    expect(down.slice(1).map((f) => (f as TextFrame).text)).toEqual(["in progress", "queued"]);
  });

  test("test_an_interruption_after_cancel_frame_in_progress_still_interrupts", async () => {
    const processor = new _CancelInProgressProcessor();
    const inProgress = new TextFrame({ text: "in progress" });
    const framesToSend = [
      inProgress,
      new SleepFrame({ sleep: 0.1 }),
      new _CancelInProgressFrame({ target: inProgress }),
      new TextFrame({ text: "next" }),
      new SleepFrame({ sleep: 0.1 }),
      new InterruptionFrame(),
    ];
    await runTest(processor, {
      framesToSend,
      expectedDownFrames: [_CancelInProgressFrame, InterruptionFrame],
    });
    expect(processor.cancelled).toEqual([true]);
  });

  test("test_interruptible_flag_decides_for_a_frame", async () => {
    // A plain frame marked uninterruptible survives, a marker frame marked
    // interruptible does not.
    interface MarkerFrameOptions {
      text: string;
    }
    class MarkerFrame extends DataFrame {
      text: string;
      override interruptible = false;
      constructor(options: MarkerFrameOptions) {
        super(options);
        this.text = options.text;
      }
    }

    class DelayTestFrameProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (!(frame instanceof SystemFrame)) {
          await sleep(0.4);
        }
        await this.pushFrame(frame, direction);
      }
    }

    const kept = new TextFrame({ text: "kept" });
    kept.interruptible = false;
    const dropped = new MarkerFrame({ text: "dropped" });
    dropped.interruptible = true;

    const pipeline = new Pipeline([new DelayTestFrameProcessor()]);
    const framesToSend = [kept, dropped, new SleepFrame(), new InterruptionFrame()];
    const expectedDownFrames = [InterruptionFrame, TextFrame];
    const [received] = await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
    });
    expect(
      received.filter((f): f is TextFrame => f instanceof TextFrame).map((f) => f.text),
    ).toEqual(["kept"]);
  });

  test("test_broadcast_frame", async () => {
    // Test that broadcastFrame creates two separate frames with fresh IDs.
    const downstreamFrames: Frame[] = [];
    const upstreamFrames: Frame[] = [];

    class BroadcastTestProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof TextFrame) {
          await this.broadcastFrame(BroadcastTestFrame, {
            text: "hello",
            value: 42,
            items: ["a", "b"],
          });
        } else {
          await this.pushFrame(frame, direction);
        }
      }
    }

    const upCapture = new CaptureProcessor(upstreamFrames, FrameDirection.UPSTREAM);
    const broadcaster = new BroadcastTestProcessor();
    const downCapture = new CaptureProcessor(downstreamFrames, FrameDirection.DOWNSTREAM);

    const pipeline = new Pipeline([upCapture, broadcaster, downCapture]);

    const framesToSend = [new TextFrame({ text: "trigger" })];
    const expectedDownFrames = [BroadcastTestFrame];
    const expectedUpFrames = [BroadcastTestFrame];

    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
      expectedUpFrames,
    });

    // Verify we got one frame in each direction
    expect(downstreamFrames.length).toEqual(1);
    expect(upstreamFrames.length).toEqual(1);

    const downFrame = downstreamFrames[0] as BroadcastTestFrame;
    const upFrame = upstreamFrames[0] as BroadcastTestFrame;

    // Verify the frames have different IDs (they are separate instances)
    expect(downFrame.id).not.toEqual(upFrame.id);

    // Verify the frames have the correct field values
    expect(downFrame.text).toEqual("hello");
    expect(downFrame.value).toEqual(42);
    expect(downFrame.items).toEqual(["a", "b"]);
    expect(upFrame.text).toEqual("hello");
    expect(upFrame.value).toEqual(42);
    expect(upFrame.items).toEqual(["a", "b"]);

    // Verify the items lists are shared references (no deep copy)
    expect(downFrame.items).toBe(upFrame.items);
  });

  test("test_broadcast_frame_instance", async () => {
    // Test that broadcastFrameInstance shallow-copies all fields except id and name.
    const downstreamFrames: Frame[] = [];
    const upstreamFrames: Frame[] = [];
    const originalFrame: Frame[] = [];

    class BroadcastInstanceTestProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof BroadcastTestFrame) {
          // Set some non-init fields on the frame
          frame.pts = 12345;
          frame.metadata = { key: "value", nested: { a: 1 } };
          originalFrame.push(frame);
          await this.broadcastFrameInstance(frame);
        } else {
          await this.pushFrame(frame, direction);
        }
      }
    }

    const upCapture = new CaptureProcessor(upstreamFrames, FrameDirection.UPSTREAM);
    const broadcaster = new BroadcastInstanceTestProcessor();
    const downCapture = new CaptureProcessor(downstreamFrames, FrameDirection.DOWNSTREAM);

    const pipeline = new Pipeline([upCapture, broadcaster, downCapture]);

    // Create a frame with mutable fields to test shallow copying
    const testFrame = new BroadcastTestFrame({ text: "test", value: 99, items: ["x", "y", "z"] });

    const framesToSend = [testFrame];
    const expectedDownFrames = [BroadcastTestFrame];
    const expectedUpFrames = [BroadcastTestFrame];

    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
      expectedUpFrames,
    });

    // Verify we got one frame in each direction
    expect(downstreamFrames.length).toEqual(1);
    expect(upstreamFrames.length).toEqual(1);
    expect(originalFrame.length).toEqual(1);

    const orig = originalFrame[0] as BroadcastTestFrame;
    const downFrame = downstreamFrames[0] as BroadcastTestFrame;
    const upFrame = upstreamFrames[0] as BroadcastTestFrame;

    // Verify the frames have different IDs and names (fresh values)
    expect(downFrame.id).not.toEqual(orig.id);
    expect(upFrame.id).not.toEqual(orig.id);
    expect(downFrame.id).not.toEqual(upFrame.id);
    expect(downFrame.name).not.toEqual(orig.name);
    expect(upFrame.name).not.toEqual(orig.name);

    // Verify init fields are copied correctly
    expect(downFrame.text).toEqual("test");
    expect(downFrame.value).toEqual(99);
    expect(downFrame.items).toEqual(["x", "y", "z"]);
    expect(upFrame.text).toEqual("test");
    expect(upFrame.value).toEqual(99);
    expect(upFrame.items).toEqual(["x", "y", "z"]);

    // Verify non-init fields (except id/name) are copied
    expect(downFrame.pts).toEqual(12345);
    expect(downFrame.metadata).toEqual({ key: "value", nested: { a: 1 } });
    expect(upFrame.pts).toEqual(12345);
    expect(upFrame.metadata).toEqual({ key: "value", nested: { a: 1 } });

    // Verify mutable fields are shallow-copied (shared references)
    expect(downFrame.items).toBe(orig.items);
    expect(upFrame.items).toBe(orig.items);
    expect(downFrame.metadata).toBe(orig.metadata);
    expect(upFrame.metadata).toBe(orig.metadata);
  });

  test("test_terminal_frames_survive_interruption", async () => {
    // Test that EndFrame survives interruption (it is uninterruptible).
    //
    // This test simulates issue #3524 where an InterruptionFrame during slow
    // processing would cause terminal frames to be lost, freezing the pipeline.
    const receivedFrames: Frame[] = [];

    /**
     * This processor delays processing and then generates an interruption.
     *
     * When processing a TextFrame, it sleeps and then pushes an
     * InterruptionFrame to simulate what happens when interruption occurs
     * while a terminal frame is in the queue.
     */
    class DelayAndInterruptProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof TextFrame) {
          // Delay to allow EndFrame to be queued
          await sleep(0.1);
          // Push interruption - this should NOT discard the EndFrame
          await this.pushFrame(new InterruptionFrame(), direction);
        }
        await this.pushFrame(frame, direction);
      }
    }

    class CaptureFrameProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        receivedFrames.push(frame);
        await this.pushFrame(frame, direction);
      }
    }

    const pipeline = new Pipeline([new DelayAndInterruptProcessor(), new CaptureFrameProcessor()]);

    const framesToSend = [new TextFrame({ text: "trigger" })];
    const expectedDownFrames = [InterruptionFrame, TextFrame];
    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
    });

    // Verify EndFrame was received by our capture processor (survived interruption)
    // Note: runTest filters EndFrame from expectedDownFrames when sendEndFrame=true,
    // but our capture processor sees it before that filtering.
    const endFrames = receivedFrames.filter((f) => f instanceof EndFrame);
    expect(endFrames.length, "EndFrame should survive interruption").toEqual(1);
  });

  test("test_stop_frame_survives_interruption", async () => {
    // Test that StopFrame survives interruption (it is uninterruptible).
    //
    // Similar to test_terminal_frames_survive_interruption but specifically
    // for StopFrame.
    const receivedFrames: Frame[] = [];

    /** This processor delays processing and then generates an interruption. */
    class DelayAndInterruptProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof TextFrame) {
          // Delay to allow StopFrame to be queued
          await sleep(0.1);
          // Push interruption - this should NOT discard the StopFrame
          await this.pushFrame(new InterruptionFrame(), direction);
        }
        await this.pushFrame(frame, direction);
      }
    }

    class CaptureFrameProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        receivedFrames.push(frame);
        await this.pushFrame(frame, direction);
      }
    }

    const pipeline = new Pipeline([new DelayAndInterruptProcessor(), new CaptureFrameProcessor()]);

    const framesToSend = [new TextFrame({ text: "trigger" }), new StopFrame()];
    const expectedDownFrames = [InterruptionFrame, TextFrame, StopFrame];
    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
      sendEndFrame: false,
    });

    // Verify StopFrame was received (survived interruption)
    const stopFrames = receivedFrames.filter((f) => f instanceof StopFrame);
    expect(stopFrames.length, "StopFrame should survive interruption").toEqual(1);
  });

  test("test_broadcast_interruption_allows_subsequent_code", async () => {
    // Test that broadcastInterruption() returns immediately, allowing the
    // caller to run code afterwards (e.g. push an urgent frame).
    let codeAfterRan = false;

    class InterruptOnTextProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof TextFrame) {
          await this.broadcastInterruption();

          codeAfterRan = true;
          await this.pushFrame(new OutputTransportMessageUrgentFrame({ message: "done" }));
        } else {
          await this.pushFrame(frame, direction);
        }
      }
    }

    const pipeline = new Pipeline([new InterruptOnTextProcessor()]);

    const framesToSend = [new TextFrame({ text: "trigger" })];
    const expectedDownFrames = [InterruptionFrame, OutputTransportMessageUrgentFrame];
    await runTest(pipeline, {
      framesToSend,
      expectedDownFrames,
    });
    expect(codeAfterRan, "Code after broadcastInterruption() should execute").toBe(true);
  });

  test("test_pause_frames_until_holds_then_delivers_in_order", async () => {
    // Frames arriving before the condition is met are delivered once it is.
    const ready = new Event();
    const received: string[] = [];

    class HoldingProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof StartFrame) {
          await this.pauseProcessingAllFramesUntil(() => ready.wait());
        } else if (frame instanceof TextFrame) {
          received.push(frame.text);
        }
        await this.pushFrame(frame, direction);
      }
    }

    const releaseLater = async (): Promise<void> => {
      await sleep(0.2);
      expect(received, "frames should be held while not ready").toEqual([]);
      ready.set();
    };

    const release = createTask(() => releaseLater());
    await runTest(new HoldingProcessor(), {
      framesToSend: [
        new TextFrame({ text: "a" }),
        new TextFrame({ text: "b" }),
        new SleepFrame({ sleep: 0.4 }),
      ],
      expectedDownFrames: [TextFrame, TextFrame],
    });
    await release;

    expect(received).toEqual(["a", "b"]);
  });

  test("test_pause_frames_until_resumes_when_never_ready", async () => {
    // A condition that is never met must not leave the processor paused.
    //
    // The pause holds both frame queues, so a processor left paused could
    // not process the frames that shut it down.
    const never = new Event();
    const received: string[] = [];

    class HoldingProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof StartFrame) {
          await this.pauseProcessingAllFramesUntil(() => never.wait(), { timeout: 0.2 });
        } else if (frame instanceof TextFrame) {
          received.push(frame.text);
        }
        await this.pushFrame(frame, direction);
      }
    }

    await waitFor(
      () =>
        runTest(new HoldingProcessor(), {
          framesToSend: [new TextFrame({ text: "a" }), new SleepFrame({ sleep: 0.5 })],
          expectedDownFrames: [TextFrame],
        }),
      10,
    );

    expect(received).toEqual(["a"]);
  });

  test("test_pause_frames_until_holds_both_queues", async () => {
    // Data frames already routed to the process queue must be held too.
    //
    // The two queues pause independently, so frames that have already moved
    // to the process queue keep draining unless it is held as well.
    //
    // DIVERGENCE: upstream reads the name-mangled flags
    // `_FrameProcessor__should_block_system_frames` / `__should_block_frames`.
    // They are `#private` here (per CONVENTIONS), so the test observes the
    // only two methods that set them instead.
    const processor = new FrameProcessor();
    const tasks: Task<unknown>[] = [];
    processor.createTask = <T>(coroutine: TaskFn<T>, _name?: string | null) => {
      const task = createTask(coroutine) as Task<T | undefined>;
      tasks.push(task);
      return task;
    };
    const pauseSystem = spyOn(processor, "pauseProcessingSystemFrames");
    const pauseFrames = spyOn(processor, "pauseProcessingFrames");

    try {
      await processor.pauseProcessingAllFramesUntil(() => new Event().wait(), { timeout: 5.0 });

      expect(pauseSystem).toHaveBeenCalledTimes(1);
      expect(pauseFrames).toHaveBeenCalledTimes(1);
    } finally {
      for (const task of tasks) task.cancel();
    }
  });

  test("test_pause_frames_until_is_a_no_op_in_direct_mode", async () => {
    // Direct mode bypasses the queues the pause acts on, so the call warns.
    const ready = new Event();
    const processor = new FrameProcessor({ enableDirectMode: true });

    let sink = "";
    const removeSink = logger.addSink((record) => {
      sink += `${record.message}\n`;
    });
    try {
      await processor.pauseProcessingAllFramesUntil(() => ready.wait());
      expect(sink).toContain("direct mode");
    } finally {
      removeSink();
    }
  });

  test("test_start_frame_is_processed_first", async () => {
    // A processor holds every frame it receives until its StartFrame.
    //
    // Processors are set up concurrently, so one that connects during setup
    // can push frames at a processor that has not started yet. Those frames
    // wait, and the StartFrame is processed ahead of them even when what is
    // waiting is itself a system frame.
    const processed: string[] = [];

    class RecordingProcessor extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        processed.push(frame.constructor.name);
      }
    }

    const processor = new RecordingProcessor();
    await processor.setup(frameProcessorSetup(new TaskManager()));
    try {
      await processor.queueFrame(new TextFrame({ text: "early" }));
      await processor.queueFrame(new UserStartedSpeakingFrame());

      await sleep(0.1);
      expect(processed, "no frame should be processed before the StartFrame").toEqual([]);

      await processor.queueFrame(new StartFrame());
      await sleep(0.1);

      expect(processed).toEqual(["StartFrame", "UserStartedSpeakingFrame", "TextFrame"]);
    } finally {
      await processor.cleanup();
    }
  });
});

describe("TestPushErrorUsability", () => {
  // The usability verdict pushError derives from an error's category, and
  // the ways a caller can override it.

  const processorFor = (): IdentityFilter => {
    const processor = new IdentityFilter();
    processor.pushFrame = mock(async () => {});
    return processor;
  };

  /** An exception whose HTTP status classifies as a permanent category. */
  const permanentError = (): Error => {
    class FakeApiError extends Error {
      status_code = 400;
    }
    return new FakeApiError("bad request");
  };

  test("test_permanent_category_marks_processor_unusable", async () => {
    const processor = processorFor();
    await processor.pushError("bad request", { exception: permanentError() });
    expect(processor.isUsable).toBe(false);
    await processor.cleanup();
  });

  test("test_explicit_category_overrides_exception_classification", async () => {
    // A caller that knows better can keep the processor usable by passing a
    // non-permanent category — e.g. an LLM service reporting a provider
    // rejection as APPLICATION after removing the rejected context message,
    // where the exception alone would classify as a permanent invalid request.
    const processor = processorFor();
    await processor.pushError("bad request", {
      exception: permanentError(),
      category: ErrorCategory.APPLICATION,
    });
    expect(processor.isUsable).toBe(true);
    await processor.cleanup();
  });

  test("test_force_treat_as_permanent_wins_over_transient_category", async () => {
    const processor = processorFor();
    await processor.pushError("kept failing", { forceTreatAsPermanent: true });
    expect(processor.isUsable).toBe(false);
    await processor.cleanup();
  });
});
