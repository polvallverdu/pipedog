// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/tests/utils.py

/** Testing utilities for Pipecat pipeline components. */

import { Event, gather, Queue, sleep, waitFor } from "@pipedog/asyncio";
import { EndFrame, type Frame, HeartbeatFrame, StartFrame, SystemFrame } from "../frames/frames.ts";
import {
  BaseObserver,
  type BaseObserverOptions,
  type FramePushed,
} from "../observers/base_observer.ts";
import { Pipeline } from "../pipeline/pipeline.ts";
import { PipelineParams, PipelineWorker } from "../pipeline/worker.ts";
import { FrameDirection, FrameProcessor } from "../processors/frame_processor.ts";
import { WorkerRunner } from "../workers/runner.ts";

/** Raised by `runTest()` when the received frames don't match the expected ones. */
export class AssertionError extends Error {
  override name = "AssertionError";
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export interface SleepFrameOptions {
  /** Duration to sleep in seconds before processing the next frame. */
  sleep?: number;
}

/**
 * A system frame that introduces a sleep delay in the test pipeline.
 *
 * This frame is used by the test framework to control timing between frame
 * processing, allowing tests to separate system frames from data or control
 * frames.
 *
 * - `sleep`: duration to sleep in seconds before processing the next frame.
 */
export class SleepFrame extends SystemFrame {
  sleep: number;

  constructor(options: SleepFrameOptions = {}) {
    super(options);
    this.sleep = options.sleep ?? 0.2;
  }
}

/** An async callback invoked when a heartbeat is detected. */
export type HeartbeatCallback = (processor: FrameProcessor, frame: HeartbeatFrame) => Promise<void>;

export interface HeartbeatsObserverOptions extends BaseObserverOptions {
  /** The frame processor to monitor for heartbeat frames. */
  target: FrameProcessor;
  /** Async callback function to invoke when heartbeats are detected. */
  heartbeatCallback: HeartbeatCallback;
}

/**
 * Observer that monitors heartbeat frames from a specific processor.
 *
 * This observer watches for HeartbeatFrames from a target processor and
 * invokes a callback when they are detected, useful for testing timing and
 * lifecycle events.
 */
export class HeartbeatsObserver extends BaseObserver {
  protected _target: FrameProcessor;
  protected _callback: HeartbeatCallback;

  constructor(options: HeartbeatsObserverOptions) {
    super(options);
    this._target = options.target;
    this._callback = options.heartbeatCallback;
  }

  /**
   * Handle frame push events and detect heartbeats from target processor.
   *
   * @param data The frame push event data containing source and frame information.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    const src = data.source;
    const frame = data.frame;

    if (src === this._target && frame instanceof HeartbeatFrame) {
      await this._callback(this._target, frame);
    }
  }
}

export interface QueuedFrameProcessorOptions {
  /** The queue to store captured frames. */
  queue: Queue<Frame>;
  /** The direction of frames to capture (UPSTREAM or DOWNSTREAM). */
  queueDirection: FrameDirection;
  /** Whether to ignore StartFrames when capturing. */
  ignoreStart?: boolean;
}

/**
 * A processor that captures frames in a queue for testing purposes.
 *
 * This processor intercepts frames flowing in a specific direction and stores
 * them in a queue for later inspection during testing, while still allowing
 * the frames to continue through the pipeline.
 */
export class QueuedFrameProcessor extends FrameProcessor {
  protected _queue: Queue<Frame>;
  protected _queueDirection: FrameDirection;
  protected _ignoreStart: boolean;

  constructor(options: QueuedFrameProcessorOptions) {
    super({ enableDirectMode: true });
    this._queue = options.queue;
    this._queueDirection = options.queueDirection;
    this._ignoreStart = options.ignoreStart ?? true;
  }

  /**
   * Process frames and capture them in the queue if they match the direction.
   *
   * @param frame The frame to process.
   * @param direction The direction the frame is flowing.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (direction === this._queueDirection) {
      if (!(frame instanceof StartFrame) || !this._ignoreStart) {
        await this._queue.put(frame);
      }
    }
    await this.pushFrame(frame, direction);
  }
}

/** A frame class, as `expectedDownFrames` / `expectedUpFrames` list them. */
export type FrameType = abstract new (...args: any[]) => Frame;

export interface RunTestOptions {
  /** Whether RTVI should be enabled in this test. */
  enableRtvi?: boolean;
  /** Expected frame types flowing downstream (optional). */
  expectedDownFrames?: readonly FrameType[] | null;
  /** Expected frame types flowing upstream (optional). */
  expectedUpFrames?: readonly FrameType[] | null;
  /** Sequence of frames to send through the processor. */
  framesToSend: readonly Frame[];
  /**
   * Direction to send `framesToSend`. Downstream frames are pushed from the
   * beginning of the pipeline, upstream frames from the end. Defaults to
   * DOWNSTREAM.
   */
  framesToSendDirection?: FrameDirection;
  /** Whether to ignore StartFrames in frame validation. */
  ignoreStart?: boolean;
  /** Optional list of observers to attach to the pipeline. */
  observers?: BaseObserver[] | null;
  /** Optional pipeline parameters. */
  pipelineParams?: PipelineParams | null;
  /** Whether to send an EndFrame at the end of the test. */
  sendEndFrame?: boolean;
  /** How long to wait, in seconds, for the pipeline to start before giving up. */
  startTimeout?: number;
}

/**
 * Run a test pipeline with the specified processor and validate frame flow.
 *
 * This function creates a test pipeline with the given processor, sends the
 * specified frames through it, and validates that the expected frames are
 * received in both upstream and downstream directions.
 *
 * @param processor The frame processor to test.
 * @returns Tuple containing [downstreamFrames, upstreamFrames] that were received.
 * @throws AssertionError if the received frames don't match the expected frame types.
 * @throws TimeoutError if the pipeline doesn't start within `startTimeout`.
 */
export async function runTest(
  processor: FrameProcessor,
  options: RunTestOptions,
): Promise<[Frame[], Frame[]]> {
  const enableRtvi = options.enableRtvi ?? false;
  const expectedDownFrames = options.expectedDownFrames ?? null;
  const expectedUpFrames = options.expectedUpFrames ?? null;
  const framesToSend = options.framesToSend;
  const framesToSendDirection = options.framesToSendDirection ?? FrameDirection.DOWNSTREAM;
  const ignoreStart = options.ignoreStart ?? true;
  const observers = options.observers ?? [];
  const pipelineParams = options.pipelineParams ?? new PipelineParams();
  const sendEndFrame = options.sendEndFrame ?? true;
  const startTimeout = options.startTimeout ?? 1.0;

  const receivedUp = new Queue<Frame>();
  const receivedDown = new Queue<Frame>();
  const source = new QueuedFrameProcessor({
    queue: receivedUp,
    queueDirection: FrameDirection.UPSTREAM,
    ignoreStart,
  });
  const sink = new QueuedFrameProcessor({
    queue: receivedDown,
    queueDirection: FrameDirection.DOWNSTREAM,
    ignoreStart,
  });

  const pipeline = new Pipeline([source, processor, sink]);

  const worker = new PipelineWorker(pipeline, {
    cancelOnIdleTimeout: false,
    enableRtvi,
    observers,
    params: pipelineParams,
  });

  const pipelineStarted = new Event();

  worker.eventHandler("on_pipeline_started", async (_worker: unknown, _frame: unknown) => {
    pipelineStarted.set();
  });

  const pushFrames = async (): Promise<void> => {
    // Processors drop frames that arrive before StartFrame, and upstream
    // frames enter at the sink, which StartFrame reaches last.
    await waitFor(() => pipelineStarted.wait(), startTimeout);
    for (const frame of framesToSend) {
      if (frame instanceof SleepFrame) {
        await sleep(frame.sleep);
      } else {
        await worker.queueFrame(frame, framesToSendDirection);
      }
    }

    if (sendEndFrame) {
      await worker.queueFrame(new EndFrame());
    }
  };

  const runner = new WorkerRunner();
  await runner.addWorkers(worker);
  await gather(
    () => runner.run(),
    () => pushFrames(),
  );

  //
  // Down frames
  //
  const receivedDownFrames: Frame[] = [];
  while (!receivedDown.empty()) {
    const frame = await receivedDown.get();
    if (!(frame instanceof EndFrame) || !sendEndFrame) {
      receivedDownFrames.push(frame);
    }
  }

  if (expectedDownFrames !== null) {
    let downFramesPrinted = "[";
    for (const frame of receivedDownFrames) {
      downFramesPrinted += `${frame.constructor.name}, `;
    }
    downFramesPrinted += "]";
    let expectedFramesPrinted = "[";
    for (const frame of expectedDownFrames) {
      expectedFramesPrinted += `${frame.name}, `;
    }
    expectedFramesPrinted += "]";
    console.log("received DOWN frames =", downFramesPrinted);
    console.log("expected DOWN frames =", expectedFramesPrinted);

    assert(
      receivedDownFrames.length === expectedDownFrames.length,
      `expected ${expectedDownFrames.length} DOWN frames, received ${receivedDownFrames.length}: ${downFramesPrinted}`,
    );

    receivedDownFrames.forEach((real, i) => {
      const expected = expectedDownFrames[i] as FrameType;
      assert(
        real instanceof expected,
        `DOWN frame ${i}: expected ${expected.name}, received ${real.constructor.name}`,
      );
    });
  }

  //
  // Up frames
  //
  const receivedUpFrames: Frame[] = [];
  while (!receivedUp.empty()) {
    const frame = await receivedUp.get();
    receivedUpFrames.push(frame);
  }

  if (expectedUpFrames !== null) {
    console.log(
      "received UP frames =",
      `[${receivedUpFrames.map((f) => f.toString()).join(", ")}]`,
    );
    console.log("expected UP frames =", `[${expectedUpFrames.map((f) => f.name).join(", ")}]`);

    assert(
      receivedUpFrames.length === expectedUpFrames.length,
      `expected ${expectedUpFrames.length} UP frames, received ${receivedUpFrames.length}`,
    );

    receivedUpFrames.forEach((real, i) => {
      const expected = expectedUpFrames[i] as FrameType;
      assert(
        real instanceof expected,
        `UP frame ${i}: expected ${expected.name}, received ${real.constructor.name}`,
      );
    });
  }

  return [receivedDownFrames, receivedUpFrames];
}
