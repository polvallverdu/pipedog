// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/filters/wake_notifier_filter.py

/** Wake notifier filter for conditional frame-based notifications. */

import type { Frame } from "../../frames/frames.ts";
import type { FrameClass } from "../../utils/frame_queue.ts";
import type { BaseNotifier } from "../../utils/sync/base_notifier.ts";
import {
  type FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "../frame_processor.ts";

export interface WakeNotifierFilterOptions extends FrameProcessorOptions {
  /** The notifier to trigger when conditions are met. */
  notifier: BaseNotifier;
  /** Frame types to monitor for potential notifications. */
  types: readonly FrameClass[];
  /**
   * Async callback that determines whether to trigger notification. Should
   * return true to trigger notification, false otherwise.
   */
  filter: (frame: Frame) => Promise<boolean>;
}

/**
 * Frame processor that conditionally triggers notifications based on frame
 * types and filters.
 *
 * This processor monitors frames of specified types and executes a callback
 * predicate when such frames are processed. If the callback returns true, the
 * associated notifier is triggered, allowing for conditional wake-up or
 * notification scenarios.
 */
export class WakeNotifierFilter extends FrameProcessor {
  protected _notifier: BaseNotifier;
  protected _types: readonly FrameClass[];
  protected _filter: (frame: Frame) => Promise<boolean>;

  /**
   * Initialize the wake notifier filter.
   *
   * @param options.notifier The notifier to trigger when conditions are met.
   * @param options.types Frame types to monitor for potential notifications.
   * @param options.filter Async callback that determines whether to trigger
   *   notification. Should return true to trigger notification, false
   *   otherwise. Other options are passed to the parent FrameProcessor.
   */
  constructor(options: WakeNotifierFilterOptions) {
    super(options);
    this._notifier = options.notifier;
    this._types = options.types;
    this._filter = options.filter;
  }

  /**
   * Process frames and conditionally trigger notifications.
   *
   * @param frame The frame to process.
   * @param direction The direction of frame flow in the pipeline.
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    if (this._types.some((t) => frame instanceof t) && (await this._filter(frame))) {
      await this._notifier.notify();
    }

    await this.pushFrame(frame, direction);
  }
}
