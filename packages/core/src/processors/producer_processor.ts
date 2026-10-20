// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/producer_processor.py

/** Producer processor for frame filtering and distribution. */

import { Queue } from "@pipedog/asyncio";
import type { Frame } from "../frames/frames.ts";
import { type FrameDirection, FrameProcessor } from "./frame_processor.ts";

/** Async function transforming a frame before it is handed on. */
export type FrameTransformer = (frame: Frame) => Promise<Frame>;

/** Async function deciding whether a frame should be produced. */
export type FrameFilter = (frame: Frame) => Promise<boolean>;

/**
 * Default transformer that returns the frame unchanged.
 *
 * @param frame The frame to transform.
 * @returns The same frame without modifications.
 */
export async function identityTransformer(frame: Frame): Promise<Frame> {
  return frame;
}

export interface ProducerProcessorOptions {
  /**
   * Async function that determines if a frame should be produced. Must return
   * true for frames to be sent to consumers.
   */
  filter: FrameFilter;
  /**
   * Async function to transform frames before sending to consumers. Defaults
   * to `identityTransformer` which returns frames unchanged.
   */
  transformer?: FrameTransformer;
  /**
   * Whether to pass frames through to the next processor. If true, all frames
   * continue downstream regardless of filter result.
   */
  passthrough?: boolean;
}

/**
 * A processor that filters frames and distributes them to multiple consumers.
 *
 * This processor receives frames, applies a filter to determine which frames
 * should be sent to consumers (ConsumerProcessor), optionally transforms those
 * frames, and distributes them to registered consumer queues. It can also pass
 * frames through to the next processor in the pipeline.
 */
export class ProducerProcessor extends FrameProcessor {
  protected _filter: FrameFilter;
  protected _transformer: FrameTransformer;
  protected _passthrough: boolean;
  protected _consumers: Queue<Frame>[] = [];

  /** Initialize the producer processor. */
  constructor(options: ProducerProcessorOptions) {
    super();
    this._filter = options.filter;
    this._transformer = options.transformer ?? identityTransformer;
    this._passthrough = options.passthrough ?? true;
  }

  /**
   * Add a new consumer and return its associated queue.
   *
   * @returns The queue for the newly added consumer.
   */
  addConsumer(): Queue<Frame> {
    const queue = new Queue<Frame>();
    this._consumers.push(queue);
    return queue;
  }

  /**
   * Process an incoming frame and determine whether to produce it.
   *
   * If the frame meets the filter criteria, it will be transformed and added
   * to all consumer queues. If passthrough is enabled, the original frame will
   * also be sent downstream.
   *
   * @param frame The frame to process.
   * @param direction The direction of the frame flow.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (await this._filter(frame)) {
      await this._produce(frame);
      if (this._passthrough) {
        await this.pushFrame(frame, direction);
      }
    } else {
      await this.pushFrame(frame, direction);
    }
  }

  /** Produce a frame to all consumers. */
  protected async _produce(frame: Frame): Promise<void> {
    for (const consumer of this._consumers) {
      const newFrame = await this._transformer(frame);
      await consumer.put(newFrame);
    }
  }
}
