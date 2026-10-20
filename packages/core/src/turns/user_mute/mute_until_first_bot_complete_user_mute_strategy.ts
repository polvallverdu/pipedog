// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_mute/mute_until_first_bot_complete_user_mute_strategy.py

/** User mute strategy that mutes the user until the bot completes its first speech. */

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  ErrorFrame,
  type Frame,
} from "../../frames/frames.ts";
import { logger } from "../../utils/logger.ts";
import { BaseUserMuteStrategy } from "./base_user_mute_strategy.ts";

/**
 * User mute strategy that mutes the user until the bot completes its first speech.
 *
 * This strategy mutes user frames immediately from the start of the
 * interaction, even if the bot has not started speaking yet. User input
 * remains muted until the bot finishes its first speaking turn.
 *
 * After the bot completes its initial speech, all subsequent user frames are
 * allowed to pass through without muting.
 *
 * Use this strategy when the bot must fully control the beginning of the
 * interaction and deliver its first response without any user interruption.
 *
 * The mute is also released if the bot's first speaking turn fails before
 * producing any audio, so that a failed opening leaves the user able to speak.
 */
export class MuteUntilFirstBotCompleteUserMuteStrategy extends BaseUserMuteStrategy {
  protected _botStartedSpeaking = false;
  protected _firstSpeechHandled = false;

  /** Initialize the mute-until-first-bot-complete user mute strategy. */
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

    if (frame instanceof BotStartedSpeakingFrame) {
      this._botStartedSpeaking = true;
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      await this._handleBotStoppedSpeaking(frame);
    } else if (frame instanceof ErrorFrame) {
      await this._handleError(frame);
    }

    return !this._firstSpeechHandled;
  }

  protected async _handleBotStoppedSpeaking(_frame: BotStoppedSpeakingFrame): Promise<void> {
    if (!this._firstSpeechHandled) {
      this._firstSpeechHandled = true;
    }
  }

  /**
   * Release the mute when the first speaking turn fails before any audio.
   *
   * No audio means no `BotStoppedSpeakingFrame`, and no later one to wait
   * for either, since a muted user can never prompt another turn. Only
   * errors before the bot starts speaking count: after that the transport
   * ends the turn on its own once the audio dries up.
   */
  protected async _handleError(frame: ErrorFrame): Promise<void> {
    if (this._botStartedSpeaking) {
      return;
    }

    if (!this._firstSpeechHandled) {
      logger.warning(
        `${this}: releasing the user mute without the bot having completed its first ` +
          `speech, after an error from ${frame.processor}: ${frame.error}`,
      );
      this._firstSpeechHandled = true;
    }
  }
}
