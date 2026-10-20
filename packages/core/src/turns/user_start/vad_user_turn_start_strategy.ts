// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_start/vad_user_turn_start_strategy.py

/** User turn start strategy based on VAD events. */

import { type Frame, VADUserStartedSpeakingFrame } from "../../frames/frames.ts";
import { ProcessFrameResult } from "../types.ts";
import { BaseUserTurnStartStrategy } from "./base_user_turn_start_strategy.ts";

/**
 * User turn start strategy based on VAD (Voice Activity Detection).
 *
 * This strategy assumes the user turn starts as soon as a VAD frame indicates
 * that the user has started speaking.
 */
export class VADUserTurnStartStrategy extends BaseUserTurnStartStrategy {
  /**
   * Process an incoming frame to detect user turn start.
   *
   * @param frame The frame to be analyzed.
   * @returns STOP if the user started speaking, CONTINUE otherwise.
   */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof VADUserStartedSpeakingFrame) {
      await this.triggerUserTurnStarted();
      return ProcessFrameResult.STOP;
    }

    return ProcessFrameResult.CONTINUE;
  }
}
