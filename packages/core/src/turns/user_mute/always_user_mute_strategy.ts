// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_mute/always_user_mute_strategy.py

/** User mute strategy that always mutes the user while the bot is speaking. */

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
} from "../../frames/frames.ts";
import { BaseUserMuteStrategy } from "./base_user_mute_strategy.ts";

/** User mute strategy that always mutes the user while the bot is speaking. */
export class AlwaysUserMuteStrategy extends BaseUserMuteStrategy {
  protected _botSpeaking = false;

  /**
   * Process an incoming frame.
   *
   * @param frame The frame to be processed.
   * @returns Whether the strategy is muted.
   */
  override async processFrame(frame: Frame): Promise<boolean> {
    await super.processFrame(frame);

    if (frame instanceof BotStartedSpeakingFrame) {
      this._botSpeaking = true;
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      this._botSpeaking = false;
    }

    return this._botSpeaking;
  }
}
