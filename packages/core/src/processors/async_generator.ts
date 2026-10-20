// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/async_generator.py

/** Async generator processor for frame serialization and streaming. */

import { Queue } from "@pipedog/asyncio";
import { CancelFrame, EndFrame, type Frame } from "../frames/frames.ts";
import type { FrameSerializer } from "../serializers/base_serializer.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "./frame_processor.ts";

export interface AsyncGeneratorProcessorOptions extends FrameProcessorOptions {
  /** The frame serializer to use for converting frames to data. */
  serializer: FrameSerializer;
}

/**
 * A frame processor that serializes frames and provides them via async generator.
 *
 * This processor passes frames through unchanged while simultaneously
 * serializing them and making the serialized data available through an async
 * generator interface. Useful for streaming frame data to external consumers
 * while maintaining the normal frame processing pipeline.
 */
export class AsyncGeneratorProcessor extends FrameProcessor {
  protected _serializer: FrameSerializer;
  protected _dataQueue = new Queue<unknown>();

  /**
   * Initialize the async generator processor.
   *
   * @param options.serializer The frame serializer to use for converting frames to data.
   */
  constructor(options: AsyncGeneratorProcessorOptions) {
    super(options);
    this._serializer = options.serializer;
  }

  /**
   * Process frames by passing them through and queuing serialized data.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    await this.pushFrame(frame, direction);

    if (frame instanceof CancelFrame || frame instanceof EndFrame) {
      await this._dataQueue.put(null);
    } else {
      const data = await this._serializer.serialize(frame);
      if (isTruthy(data)) {
        await this._dataQueue.put(data);
      }
    }
  }

  /**
   * Generate serialized frame data asynchronously.
   *
   * Yields serialized frame data from the internal queue until a termination
   * signal (null) is received.
   */
  async *generator(): AsyncGenerator<unknown, void, unknown> {
    let running = true;
    while (running) {
      const data = await this._dataQueue.get();
      running = data !== null;
      if (isTruthy(data)) {
        yield data;
      }
    }
  }
}

/** Python truthiness for serialized data: empty strings and byte arrays are falsy. */
function isTruthy(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  if (typeof data === "string") return data.length > 0;
  if (data instanceof Uint8Array) return data.length > 0;
  return Boolean(data);
}
