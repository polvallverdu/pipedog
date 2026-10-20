// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_mute/function_call_user_mute_strategy.py

/** User mute strategy that mutes the user while a function call is executing. */

import {
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
} from "../../frames/frames.ts";
import { BaseUserMuteStrategy } from "./base_user_mute_strategy.ts";

/**
 * User mute strategy that mutes the user while a function call is executing.
 *
 * This strategy ensures that user input does not interfere with ongoing
 * function execution. While a function call is active, all user frames are
 * muted. Once the function call completes or is canceled, user input is
 * allowed again.
 */
export class FunctionCallUserMuteStrategy extends BaseUserMuteStrategy {
  protected _functionCallInProgress = new Set<string>();

  /** Initialize the function call user mute strategy. */
  constructor() {
    super();
  }

  /**
   * Process an incoming frame.
   *
   * @param frame The frame to be processed.
   * @returns Whether the strategy is muted.
   */
  override async processFrame(frame: Frame): Promise<boolean> {
    await super.processFrame(frame);

    if (frame instanceof FunctionCallsStartedFrame) {
      await this._handleFunctionCallsStarted(frame);
    } else if (
      frame instanceof FunctionCallCancelFrame ||
      frame instanceof FunctionCallResultFrame
    ) {
      // Untracked ids reach here: a built-in cancel tool is excluded from
      // FunctionCallsStartedFrame yet still emits a result, async tools
      // emit a result frame per intermediate update, and a bus bridge can
      // re-deliver a result another worker already handled.
      this._functionCallInProgress.delete(frame.toolCallId);
    }

    return this._functionCallInProgress.size > 0;
  }

  protected async _handleFunctionCallsStarted(frame: FunctionCallsStartedFrame): Promise<void> {
    for (const f of frame.functionCalls) {
      this._functionCallInProgress.add(f.toolCallId);
    }
  }
}
