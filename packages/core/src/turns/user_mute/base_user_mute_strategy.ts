// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_mute/base_user_mute_strategy.py

/** Base strategy for deciding whether user frames should be muted. */

import type { Frame } from "../../frames/frames.ts";
import type { FrameProcessorSetup } from "../../processors/frame_processor.ts";
import { BaseObject, type BaseObjectOptions } from "../../utils/base_object.ts";

export interface BaseUserMuteStrategyOptions extends BaseObjectOptions {}

/**
 * Base class for strategies that decide whether user frames should be muted.
 *
 * A user mute strategy determines whether incoming user frames should be
 * suppressed based on the *current system state*.
 *
 * Typical heuristics include:
 * - The bot is currently speaking, so user should be muted
 * - A function call or tool execution is in progress
 * - The system is otherwise not ready to accept user input
 *
 * The strategy is evaluated per frame and returns a boolean indicating whether
 * the user should be muted.
 */
export class BaseUserMuteStrategy extends BaseObject {
  constructor(options: BaseUserMuteStrategyOptions = {}) {
    super(options);
  }

  /**
   * Set up the strategy.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup.taskManager);
  }

  /** Cleanup the strategy. */
  override async cleanup(): Promise<void> {}

  /**
   * Process an incoming frame.
   *
   * @param frame The frame to be processed.
   * @returns Whether the strategy is muted.
   */
  async processFrame(_frame: Frame): Promise<boolean> {
    return false;
  }
}
