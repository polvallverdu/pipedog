// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/text_transformer.py

/** Stateless text transformation processor for Pipecat. */

import { type Frame, TextFrame } from "../frames/frames.ts";
import { type FrameDirection, FrameProcessor } from "./frame_processor.ts";

/** A text transformation, synchronous or asynchronous. */
export type TextTransformFn = (text: string) => string | Promise<string>;

/**
 * Processor that applies transformation functions to text frames.
 *
 * This processor intercepts TextFrame objects and applies a user-provided
 * transformation function to the text content. The function can be either
 * synchronous or asynchronous.
 */
export class StatelessTextTransformer extends FrameProcessor {
  protected _transformFn: TextTransformFn;

  /**
   * Initialize the text transformer.
   *
   * @param transformFn Function to apply to text content. Can be synchronous
   *   (string -> string) or asynchronous (string -> Promise<string>).
   */
  constructor(transformFn: TextTransformFn) {
    super();
    this._transformFn = transformFn;
  }

  /**
   * Process frames, applying transformation to text frames.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof TextFrame) {
      let result = this._transformFn(frame.text);
      if (result instanceof Promise) {
        result = await result;
      }
      await this.pushFrame(new TextFrame({ text: result }));
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}
