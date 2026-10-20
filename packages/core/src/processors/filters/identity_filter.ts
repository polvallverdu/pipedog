// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/filters/identity_filter.py

/**
 * Identity filter for transparent frame passthrough.
 *
 * This module provides a simple passthrough filter that forwards all frames
 * without modification, useful for testing and pipeline composition.
 */

import type { Frame } from "../../frames/frames.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../frame_processor.ts";

export interface IdentityFilterOptions extends FrameProcessorOptions {}

/**
 * A pass-through filter that forwards all frames without modification.
 *
 * This filter acts as a transparent passthrough, allowing all frames to flow
 * through unchanged. It can be useful when testing `ParallelPipeline` to
 * create pipelines that pass through frames (no frames should be repeated).
 */
export class IdentityFilter extends FrameProcessor {
  /**
   * Initialize the identity filter.
   *
   * @param options Options passed to the parent FrameProcessor.
   */
  constructor(options: IdentityFilterOptions = {}) {
    super(options);
  }

  //
  // Frame processor
  //

  /**
   * Process an incoming frame by passing it through unchanged.
   *
   * @param frame The frame to process and forward.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    await this.pushFrame(frame, direction);
  }
}
