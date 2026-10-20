// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/base_observer.py

/**
 * Base observer classes for monitoring frame flow in the Pipecat pipeline.
 *
 * Provides the foundation for observing frame transfers between processors
 * without modifying the pipeline structure. Observers can be used for logging,
 * debugging, analytics, and monitoring pipeline behavior.
 */

import type { Frame } from "../frames/frames.ts";
import type { FrameDirection, FrameProcessor } from "../processors/frame_processor.ts";
import { BaseObject, type BaseObjectOptions } from "../utils/base_object.ts";

export interface FrameProcessedOptions {
  /** The processor processing the frame. */
  processor: FrameProcessor;
  /** The frame being processed. */
  frame: Frame;
  /** The direction of the frame (e.g., downstream or upstream). */
  direction: FrameDirection;
  /** The time when the frame was pushed, based on the pipeline clock. */
  timestamp: number;
}

/**
 * Event data for frame processing in the pipeline.
 *
 * Represents an event where a frame is being processed by a processor. This
 * data structure is typically used by observers to track the flow of frames
 * through the pipeline for logging, debugging, or analytics purposes.
 *
 * - `processor`: the processor processing the frame.
 * - `frame`: the frame being processed.
 * - `direction`: the direction of the frame (e.g., downstream or upstream).
 * - `timestamp`: the time when the frame was pushed, based on the pipeline clock.
 */
export class FrameProcessed {
  processor: FrameProcessor;
  frame: Frame;
  direction: FrameDirection;
  timestamp: number;

  constructor(options: FrameProcessedOptions) {
    this.processor = options.processor;
    this.frame = options.frame;
    this.direction = options.direction;
    this.timestamp = options.timestamp;
  }
}

export interface FramePushedOptions {
  /** The processor sending the frame. */
  source: FrameProcessor;
  /** The processor receiving the frame. */
  destination: FrameProcessor;
  /** The frame being transferred. */
  frame: Frame;
  /** The direction of the transfer (e.g., downstream or upstream). */
  direction: FrameDirection;
  /** The time when the frame was pushed, based on the pipeline clock. */
  timestamp: number;
  /** Whether this is the first time the frame is pushed. Defaults to true. */
  firstPush?: boolean;
}

/**
 * Event data for frame transfers between processors in the pipeline.
 *
 * Represents an event where a frame is pushed from one processor to another
 * within the pipeline. This data structure is typically used by observers
 * to track the flow of frames through the pipeline for logging, debugging,
 * or analytics purposes.
 *
 * - `source`: the processor sending the frame.
 * - `destination`: the processor receiving the frame.
 * - `frame`: the frame being transferred.
 * - `direction`: the direction of the transfer (e.g., downstream or upstream).
 * - `timestamp`: the time when the frame was pushed, based on the pipeline clock.
 * - `firstPush`: whether this is the first time the frame is pushed. A frame
 *   is pushed again by every processor that passes it along.
 */
export class FramePushed {
  source: FrameProcessor;
  destination: FrameProcessor;
  frame: Frame;
  direction: FrameDirection;
  timestamp: number;
  firstPush: boolean;

  constructor(options: FramePushedOptions) {
    this.source = options.source;
    this.destination = options.destination;
    this.frame = options.frame;
    this.direction = options.direction;
    this.timestamp = options.timestamp;
    this.firstPush = options.firstPush ?? true;
  }
}

export interface ProcessorSetUpOptions {
  /** The processor that was set up. */
  processor: FrameProcessor;
  /** When the processor's `setup()` began. */
  startedAtNs: number;
  /** When the processor's `setup()` returned. */
  finishedAtNs: number;
}

/**
 * Event data for a processor having been set up.
 *
 * Processors are set up concurrently and before any frame flows, so this is
 * what a timing observer measures the work a processor does to get ready by.
 * The times come from `monotonicNs()`, since the pipeline clock only starts
 * once the pipeline does.
 *
 * - `processor`: the processor that was set up.
 * - `startedAtNs`: when the processor's `setup()` began.
 * - `finishedAtNs`: when the processor's `setup()` returned.
 */
export class ProcessorSetUp {
  processor: FrameProcessor;
  startedAtNs: number;
  finishedAtNs: number;

  constructor(options: ProcessorSetUpOptions) {
    this.processor = options.processor;
    this.startedAtNs = options.startedAtNs;
    this.finishedAtNs = options.finishedAtNs;
  }
}

export interface BaseObserverOptions extends BaseObjectOptions {
  /**
   * Whether to observe every push of a frame, rather than only its first.
   * Defaults to true.
   */
  observeEveryPush?: boolean;
}

/**
 * Base class for pipeline frame observers.
 *
 * Observers can view all frames that flow through the pipeline without
 * needing to inject processors into the pipeline structure. This enables
 * non-intrusive monitoring capabilities such as frame logging, debugging,
 * performance analysis, and analytics collection.
 *
 * A frame is pushed again by every processor that passes it along, and by
 * default an observer observes every push. An observer that handles a frame
 * once, such as one that reports the moment a frame represents, is created
 * with `observeEveryPush: false` and is told about a frame only when it
 * is first pushed.
 */
export class BaseObserver extends BaseObject {
  protected _observeEveryPush: boolean;

  constructor(options: BaseObserverOptions = {}) {
    super(options);
    this._observeEveryPush = options.observeEveryPush ?? true;
  }

  /** Whether the observer observes every push of a frame, not only the first. */
  get observeEveryPush(): boolean {
    return this._observeEveryPush;
  }

  /**
   * Handle the event when a frame is being processed by a processor.
   *
   * Subclasses implement this to define specific behavior (e.g., logging,
   * monitoring, debugging) when a frame is being processed by a processor.
   *
   * @param data The event data containing details about the frame processing.
   */
  async onProcessFrame(_data: FrameProcessed): Promise<void> {}

  /**
   * Handle the event when a frame is pushed from one processor to another.
   *
   * Subclasses implement this to define specific behavior (e.g., logging,
   * monitoring, debugging) when a frame is transferred through the pipeline.
   *
   * A frame is pushed again by every processor that passes it along, so
   * this is called once per hop, with `data.firstPush` set on the first
   * one. An observer created with `observeEveryPush: false` is only
   * called for that first push.
   *
   * @param data The event data containing details about the frame transfer.
   */
  async onPushFrame(_data: FramePushed): Promise<void> {}

  /**
   * Handle the event when a processor has been set up.
   *
   * A processor connects and does its other slow start-up work here, so
   * this is where that cost can be measured. Processors are set up
   * concurrently, so these arrive in the order they finish rather than in
   * pipeline order.
   *
   * @param data The event data containing details about the processor setup.
   */
  async onProcessorSetup(_data: ProcessorSetUp): Promise<void> {}

  /**
   * Called when the pipeline has fully started.
   *
   * Fired after the `StartFrame` has been processed by all processors in the
   * pipeline, including nested `ParallelPipeline` branches.
   */
  async onPipelineStarted(): Promise<void> {}
}
