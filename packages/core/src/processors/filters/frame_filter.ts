// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/filters/frame_filter.py

/** Frame filtering processor for the Pipecat framework. */

import { EndFrame, type Frame, SystemFrame } from "../../frames/frames.ts";
import type { FrameClass } from "../../utils/frame_queue.ts";
import { type FrameDirection, FrameProcessor } from "../frame_processor.ts";

export interface FrameFilterOptions {
  /**
   * Frame types that should be allowed to pass through the filter. All other
   * frame types (except SystemFrame and EndFrame) will be blocked.
   */
  types: readonly FrameClass[];
}

/**
 * A frame processor that filters frames based on their types.
 *
 * This processor acts as a selective gate in the pipeline, allowing only
 * frames of specified types to pass through. System and end frames are
 * automatically allowed to pass through to maintain pipeline integrity.
 */
export class FrameFilter extends FrameProcessor {
  protected _types: readonly FrameClass[];

  /**
   * Initialize the frame filter.
   *
   * @param options.types Frame types that should be allowed to pass through
   *   the filter. All other frame types (except SystemFrame and EndFrame) will
   *   be blocked.
   */
  constructor(options: FrameFilterOptions) {
    super();
    this._types = options.types;
  }

  //
  // Frame processor
  //

  /** Determine if a frame should pass through the filter. */
  protected _shouldPassthroughFrame(frame: Frame): boolean {
    if (this._types.some((t) => frame instanceof t)) {
      return true;
    }

    return frame instanceof EndFrame || frame instanceof SystemFrame;
  }

  /**
   * Process an incoming frame and conditionally pass it through.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (this._shouldPassthroughFrame(frame)) {
      await this.pushFrame(frame, direction);
    }
  }
}
