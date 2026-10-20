// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/bus/bridge_processor.py

/**
 * Bus bridge and edge processors for inter-worker frame routing.
 *
 * Provides:
 *
 * - `BusBridgeProcessor`: a mid-pipeline processor that exchanges frames with
 *   other workers through the bus, consuming local frames.
 * - `_BusEdgeProcessor`: a pipeline-edge processor used internally by
 *   `PipelineWorker` when `bridged` is set. Tees frames between the local
 *   pipeline and the bus (frames continue locally and are also forwarded to
 *   the bus).
 */

import {
  CancelFrame,
  EndFrame,
  type Frame,
  OutputTransportMessageUrgentFrame,
  PipelineFlushFrame,
  StartFrame,
  StopFrame,
} from "../frames/frames.ts";
import type { PipelineWorker } from "../pipeline/worker.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
  type FrameProcessorSetup,
} from "../processors/frame_processor.ts";
import type { FrameClass } from "../utils/frame_queue.ts";
import type { WorkerBus } from "./bus.ts";
import { BusFrameMessage, type BusMessage } from "./messages.ts";
import { BusSubscriber } from "./subscriber.ts";

const _LIFECYCLE_FRAMES: readonly FrameClass[] = [StartFrame, EndFrame, CancelFrame, StopFrame];
const _PASSTHROUGH_FRAMES: readonly FrameClass[] = [OutputTransportMessageUrgentFrame];

function isInstanceOfAny(frame: Frame, types: readonly FrameClass[]): boolean {
  return types.some((type) => frame instanceof type);
}

export interface BusBridgeProcessorOptions extends FrameProcessorOptions {
  /** The `WorkerBus` to exchange frames with. */
  bus: WorkerBus;
  /** Name of the owning worker, used as message source. */
  workerName: string;
  /** When set, only exchange frames with this worker. */
  targetWorker?: string | null;
  /**
   * Optional bridge name for routing. When set, outgoing frames are tagged
   * with this name and only incoming frames with the same bridge name are
   * accepted.
   */
  bridge?: string | null;
  /**
   * Extra frame types that should never cross the bus (on top of lifecycle
   * frames which are always excluded).
   */
  excludeFrames?: readonly FrameClass[] | null;
}

/**
 * Bidirectional mid-pipeline bridge between a Pipecat pipeline and the bus.
 *
 * Placed in a transport or session worker's pipeline to exchange frames with
 * other workers via the `WorkerBus`. Lifecycle and excluded frames pass
 * through locally without crossing the bus.
 */
export class BusBridgeProcessor extends BusSubscriber(FrameProcessor) {
  protected _bus: WorkerBus;
  protected _workerName: string;
  protected _targetWorker: string | null;
  protected _bridge: string | null;
  protected _excludeFrames: readonly FrameClass[];

  /**
   * Initialize the BusBridgeProcessor.
   *
   * The deprecated `target_task` parameter is not ported; use `targetWorker`.
   */
  constructor(options: BusBridgeProcessorOptions) {
    super(options);
    this._bus = options.bus;
    this._workerName = options.workerName;
    this._targetWorker = options.targetWorker ?? null;
    this._bridge = options.bridge ?? null;
    this._excludeFrames = options.excludeFrames ?? [];
  }

  /** Subscribe to the bus during processor setup. */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    await this._bus.subscribe(this);
  }

  /** Unsubscribe from the bus on cleanup. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._bus.unsubscribe(this);
  }

  /**
   * Process a frame: send to bus, or pass through locally if excluded.
   *
   * @param frame The frame to process.
   * @param direction The direction the frame is traveling.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // Lifecycle frames never cross the bus
    if (isInstanceOfAny(frame, _LIFECYCLE_FRAMES)) {
      await this.pushFrame(frame, direction);
      return;
    }

    // Urgent transport frames belong to this pipeline rather than to a
    // peer: they have to reach the transport even with no peer active.
    if (isInstanceOfAny(frame, _PASSTHROUGH_FRAMES)) {
      await this.pushFrame(frame, direction);
      return;
    }

    // Excluded frames never cross the bus
    if (this._excludeFrames.length > 0 && isInstanceOfAny(frame, this._excludeFrames)) {
      await this.pushFrame(frame, direction);
      return;
    }

    // Send to bus
    const msg = new BusFrameMessage({
      source: this._workerName,
      frame,
      direction,
      bridge: this._bridge,
    });
    await this._bus.send(msg);
  }

  /**
   * Handle an incoming bus message by pushing its frame into the pipeline.
   *
   * @param message The bus message to handle.
   */
  override async onBusMessage(message: BusMessage): Promise<void> {
    if (!(message instanceof BusFrameMessage)) {
      return;
    }

    // Skip own frames
    if (message.source === this._workerName) {
      return;
    }

    // Filter by bridge name
    if (this._bridge && message.bridge !== this._bridge) {
      return;
    }

    // If targetWorker set, only accept from that worker
    if (this._targetWorker && message.source !== this._targetWorker) {
      return;
    }

    // If message targeted at someone else, skip
    if (message.target && message.target !== this._workerName) {
      return;
    }

    // The frame has cleared every filter, so this pipeline is the one
    // taking it in.
    if (message.frame instanceof PipelineFlushFrame) {
      this.pipelineWorker.trackFlushProbe(message.frame);
    }

    await this.pushFrame(message.frame, message.direction);
  }
}

export interface _BusEdgeProcessorOptions extends FrameProcessorOptions {
  /**
   * The owning worker; the edge reads `worker.bus` lazily so the bus only
   * needs to be set (via `PipelineWorker.attach`) by the time the processor
   * is set up. `worker.name` is the message source.
   */
  worker: PipelineWorker;
  /** Direction this edge captures and publishes to the bus. */
  direction: FrameDirection;
  /**
   * Extra frame types that should never cross the bus (lifecycle frames are
   * always excluded).
   */
  excludeFrames?: readonly FrameClass[] | null;
}

/**
 * Pipeline-edge tap that publishes local frames onto the bus.
 *
 * Placed by `PipelineWorker` at the source and sink of a bridged pipeline.
 * Frames always continue through the local pipeline; in addition, frames
 * travelling in `direction` are published to the bus. The opposite path, a
 * frame arriving from the bus, belongs to the worker, which queues it into
 * the pipeline itself.
 *
 * Internal to pipecat (used by `pipeline/worker.ts`); exported only for that.
 */
export class _BusEdgeProcessor extends FrameProcessor {
  protected _task: PipelineWorker;
  protected _direction: FrameDirection;
  protected _excludeFrames: readonly FrameClass[];

  constructor(options: _BusEdgeProcessorOptions) {
    super(options);
    this._task = options.worker;
    this._direction = options.direction;
    this._excludeFrames = options.excludeFrames ?? [];
  }

  /** Pass the frame through locally and forward matching ones to the bus. */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);

    if (direction !== this._direction) {
      return;
    }
    if (isInstanceOfAny(frame, _LIFECYCLE_FRAMES)) {
      return;
    }
    if (this._excludeFrames.length > 0 && isInstanceOfAny(frame, this._excludeFrames)) {
      return;
    }

    await this._task.bus.send(new BusFrameMessage({ source: this._task.name, frame, direction }));
  }
}
