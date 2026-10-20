// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_mute/first_speech_user_mute_strategy.py

/** User mute strategy that mutes the user only during the bot’s first speech. */

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
} from "../../frames/frames.ts";
import { BaseUserMuteStrategy } from "./base_user_mute_strategy.ts";

/**
 * User mute strategy that mutes the user only during the bot’s first speech.
 *
 * This strategy allows user input before the bot starts speaking. Once the bot
 * begins its first speaking turn, user frames are muted until the bot finishes
 * that speech. After the bot completes its first speaking turn, user input is
 * no longer muted by this strategy.
 *
 * Use this strategy when early user input is acceptable, but interruptions
 * during the bot’s initial response should be prevented.
 */
export class FirstSpeechUserMuteStrategy extends BaseUserMuteStrategy {
  protected _botSpeaking = false;
  protected _firstSpeechHandled = false;

  /**
   * Process an incoming frame.
   *
   * @param frame The frame to be processed.
   * @returns Whether the strategy is muted.
   */
  override async processFrame(frame: Frame): Promise<boolean> {
    await super.processFrame(frame);

    if (frame instanceof BotStartedSpeakingFrame) {
      await this._handleBotStartedSpeaking(frame);
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      await this._handleBotStoppedSpeaking(frame);
    }

    if (this._botSpeaking && !this._firstSpeechHandled) {
      return true;
    }

    return false;
  }

  protected async _handleBotStartedSpeaking(_frame: BotStartedSpeakingFrame): Promise<void> {
    this._botSpeaking = true;
  }

  protected async _handleBotStoppedSpeaking(_frame: BotStoppedSpeakingFrame): Promise<void> {
    this._botSpeaking = false;
    if (!this._firstSpeechHandled) {
      this._firstSpeechHandled = true;
    }
  }
}
