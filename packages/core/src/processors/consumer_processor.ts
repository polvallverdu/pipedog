// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/consumer_processor.py

/** Consumer processor for consuming frames from ProducerProcessor queues. */

import type { Queue, Task } from "@pipedog/asyncio";
import { CancelFrame, EndFrame, type Frame, StartFrame } from "../frames/frames.ts";
import { FrameDirection, FrameProcessor, type FrameProcessorOptions } from "./frame_processor.ts";
import {
  type FrameTransformer,
  identityTransformer,
  type ProducerProcessor,
} from "./producer_processor.ts";

export interface ConsumerProcessorOptions extends FrameProcessorOptions {
  /** The producer processor to consume frames from. */
  producer: ProducerProcessor;
  /** Function to transform frames before pushing. Defaults to `identityTransformer`. */
  transformer?: FrameTransformer;
  /** Direction to push consumed frames. Defaults to DOWNSTREAM. */
  direction?: FrameDirection;
}

/**
 * Frame processor that consumes frames from a ProducerProcessor's queue.
 *
 * This processor passes through frames normally while also consuming frames
 * from a ProducerProcessor's queue. When frames are received from the producer
 * queue, they are optionally transformed and pushed in the specified direction.
 */
export class ConsumerProcessor extends FrameProcessor {
  protected _transformer: FrameTransformer;
  protected _direction: FrameDirection;
  protected _producer: ProducerProcessor;
  protected _consumerTask: Task<unknown> | null = null;
  protected _queue: Queue<Frame> | null = null;

  /** Initialize the consumer processor. */
  constructor(options: ConsumerProcessorOptions) {
    super(options);
    this._transformer = options.transformer ?? identityTransformer;
    this._direction = options.direction ?? FrameDirection.DOWNSTREAM;
    this._producer = options.producer;
  }

  /**
   * Process incoming frames and handle lifecycle events.
   *
   * @param frame The frame to process.
   * @param direction The direction the frame is traveling.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof StartFrame) {
      await this._start(frame);
    } else if (frame instanceof EndFrame) {
      await this._stop(frame);
    } else if (frame instanceof CancelFrame) {
      await this._cancel(frame);
    }

    await this.pushFrame(frame, direction);
  }

  /** Start the consumer task and register with the producer. */
  protected async _start(_frame: StartFrame): Promise<void> {
    if (!this._consumerTask) {
      this._queue = this._producer.addConsumer();
      this._consumerTask = this.createTask(() => this._consumerTaskHandler());
    }
  }

  /** Stop the consumer task. */
  protected async _stop(_frame: EndFrame): Promise<void> {
    await this._cancelConsumerTask();
  }

  /** Cancel the consumer task. */
  protected async _cancel(_frame: CancelFrame): Promise<void> {
    await this._cancelConsumerTask();
  }

  /** Clean up the processor and release resources. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this._cancelConsumerTask();
  }

  /** Cancel the consumer task, idempotently. */
  protected async _cancelConsumerTask(): Promise<void> {
    if (this._consumerTask) {
      await this.cancelTask(this._consumerTask);
      this._consumerTask = null;
    }
  }

  /** Handle consuming frames from the producer queue. */
  protected async _consumerTaskHandler(): Promise<void> {
    const queue = this._queue as Queue<Frame>;
    for (;;) {
      const frame = await queue.get();
      const newFrame = await this._transformer(frame);
      await this.queueFrame(newFrame, this._direction);
    }
  }
}
