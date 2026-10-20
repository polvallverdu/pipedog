// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/filters/function_filter.py

/**
 * Function-based frame filtering for Pipecat pipelines.
 *
 * This module provides a processor that filters frames based on a custom
 * function, allowing for flexible frame filtering logic in processing pipelines.
 */

import { CancelFrame, EndFrame, type Frame, StartFrame, SystemFrame } from "../../frames/frames.ts";
import { FrameDirection, FrameProcessor, type FrameProcessorOptions } from "../frame_processor.ts";

export type FilterType = (frame: Frame) => Promise<boolean>;

export interface FunctionFilterOptions extends FrameProcessorOptions {
  /**
   * An async function that takes a Frame and returns true if the frame should
   * pass through, false otherwise.
   */
  filter: FilterType;
  /**
   * The direction to apply filtering. Only frames moving in this direction
   * will be filtered; frames in the other direction pass through unfiltered.
   * If null, frames in both directions are filtered. Defaults to DOWNSTREAM.
   */
  direction?: FrameDirection | null;
  /** Whether to filter system frames. Defaults to false. */
  filterSystemFrames?: boolean;
}

/**
 * A frame processor that filters frames using a custom function.
 *
 * This processor allows frames to pass through based on the result of a
 * user-provided filter function. System and end frames always pass through
 * regardless of the filter result.
 */
export class FunctionFilter extends FrameProcessor {
  protected _filter: FilterType;
  protected _direction: FrameDirection | null;
  protected _filterSystemFrames: boolean;

  /**
   * Initialize the function filter.
   *
   * @param options.filter An async function that takes a Frame and returns
   *   true if the frame should pass through, false otherwise.
   * @param options.direction The direction to apply filtering. Only frames
   *   moving in this direction will be filtered; frames in the other direction
   *   pass through unfiltered. If null, frames in both directions are
   *   filtered. Defaults to DOWNSTREAM.
   * @param options.filterSystemFrames Whether to filter system frames.
   *   Defaults to false.
   */
  constructor(options: FunctionFilterOptions) {
    super(options);
    this._filter = options.filter;
    this._direction =
      options.direction === undefined ? FrameDirection.DOWNSTREAM : options.direction;
    this._filterSystemFrames = options.filterSystemFrames ?? false;
  }

  //
  // Frame processor
  //

  /** Check if a frame should pass through without filtering. */
  protected _shouldPassthroughFrame(frame: Frame, direction: FrameDirection): boolean {
    // Always passthrough frames in the wrong direction
    if (this._direction && direction !== this._direction) {
      return true;
    }

    // Always passthrough lifecycle frames
    if (frame instanceof StartFrame || frame instanceof EndFrame || frame instanceof CancelFrame) {
      return true;
    }

    // If not filtering system frames, passthrough all other system frames
    if (!this._filterSystemFrames && frame instanceof SystemFrame) {
      return true;
    }

    return false;
  }

  /**
   * Process a frame through the filter.
   *
   * @param frame The frame to process.
   * @param direction The direction the frame is moving in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    const passthrough = this._shouldPassthroughFrame(frame, direction);
    const allowed = await this._filter(frame);
    if (passthrough || allowed) {
      await this.pushFrame(frame, direction);
    }
  }
}
