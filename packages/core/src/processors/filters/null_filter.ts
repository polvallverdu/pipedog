// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/filters/null_filter.py

/**
 * Null filter processor for blocking frame transmission.
 *
 * This module provides a frame processor that blocks all frames except
 * system and end frames, useful for testing or temporarily stopping
 * frame flow in a pipeline.
 */

import { EndFrame, type Frame, SystemFrame } from "../../frames/frames.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../frame_processor.ts";

export interface NullFilterOptions extends FrameProcessorOptions {}

/**
 * A filter that blocks all frames except system and end frames.
 *
 * This processor acts as a null filter, preventing frames from passing
 * through the pipeline while still allowing essential system and end
 * frames to maintain proper pipeline operation.
 */
export class NullFilter extends FrameProcessor {
  /**
   * Initialize the null filter.
   *
   * @param options Options passed to the parent FrameProcessor.
   */
  constructor(options: NullFilterOptions = {}) {
    super(options);
  }

  //
  // Frame processor
  //

  /**
   * Process incoming frames, only allowing system and end frames through.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (frame instanceof SystemFrame || frame instanceof EndFrame) {
      await this.pushFrame(frame, direction);
    }
  }
}
