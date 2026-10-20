// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/aggregators/sentence.py

/**
 * Text sentence aggregation processor for Pipecat.
 *
 * This module provides a frame processor that accumulates text frames into
 * complete sentences, only outputting when a sentence-ending pattern is
 * detected.
 */

import {
  EagerTranscriptionFrame,
  EndFrame,
  type Frame,
  InterimTranscriptionFrame,
  TextFrame,
} from "../../frames/frames.ts";
import { matchEndofsentence } from "../../utils/string.ts";
import { type FrameDirection, FrameProcessor } from "../frame_processor.ts";

/**
 * Aggregates text frames into complete sentences.
 *
 * This processor accumulates incoming text frames until a sentence-ending
 * pattern is detected, then outputs the complete sentence as a single frame.
 * Useful for ensuring downstream processors receive coherent, complete
 * sentences rather than fragmented text.
 *
 * Frame input/output:
 *
 *     TextFrame("Hello,") -> None
 *     TextFrame(" world.") -> TextFrame("Hello, world.")
 */
export class SentenceAggregator extends FrameProcessor {
  protected _aggregation = "";

  /**
   * Initialize the sentence aggregator.
   *
   * Sets up internal state for accumulating text frames into complete sentences.
   */
  constructor() {
    super();
  }

  /**
   * Process incoming frames and aggregate text into complete sentences.
   *
   * @param frame The incoming frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // We ignore interim and eager (provisional) transcriptions at this point.
    if (frame instanceof InterimTranscriptionFrame || frame instanceof EagerTranscriptionFrame) {
      return;
    }

    if (frame instanceof TextFrame) {
      this._aggregation += frame.text;
      if (matchEndofsentence(this._aggregation)) {
        await this.pushFrame(new TextFrame({ text: this._aggregation }));
        this._aggregation = "";
      }
    } else if (frame instanceof EndFrame) {
      if (this._aggregation) {
        await this.pushFrame(new TextFrame({ text: this._aggregation }));
      }
      await this.pushFrame(frame);
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}
