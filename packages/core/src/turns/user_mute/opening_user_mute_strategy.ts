// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** User mute strategy that protects the bot's opening for a limited time. */

import { monotonic } from "@pipedog/asyncio";

import { BotStartedSpeakingFrame, type Frame } from "../../frames/frames.ts";
import { MuteUntilFirstBotCompleteUserMuteStrategy } from "./mute_until_first_bot_complete_user_mute_strategy.ts";

export interface OpeningUserMuteStrategyOptions {
  /**
   * How long the bot's first speech is protected, in seconds from when it
   * starts. After that the user can talk over the rest of it.
   */
  maxSeconds: number;
  /** Monotonic clock in seconds. Defaults to `monotonic()`; inject one in tests. */
  clock?: () => number;
}

/**
 * User mute strategy that mutes the user from the start of the interaction
 * until the bot finishes its first speech, or until that speech has played for
 * `maxSeconds`, whichever comes first.
 *
 * Like `MuteUntilFirstBotCompleteUserMuteStrategy`, it keeps the noise of the
 * first moments (a phone being picked up, a "hello?" said over the greeting)
 * from cutting the opening or reaching the LLM as a reply. Unlike it, a long
 * opening does not leave the user muted for all of it: once the protected
 * window has passed, the user can interrupt as usual.
 *
 * The window is checked as frames arrive, so it ends with the first frame
 * after `maxSeconds` (input audio keeps frames flowing). The mute is also
 * released if the first speech fails before producing any audio.
 */
export class OpeningUserMuteStrategy extends MuteUntilFirstBotCompleteUserMuteStrategy {
  protected _maxSeconds: number;
  protected _clock: () => number;
  protected _botStartedSpeakingAt: number | null = null;

  constructor(options: OpeningUserMuteStrategyOptions) {
    super();
    this._maxSeconds = options.maxSeconds;
    this._clock = options.clock ?? monotonic;
  }

  /**
   * Process an incoming frame.
   *
   * @param frame The frame to be processed.
   * @returns Whether the strategy is muted.
   */
  override async processFrame(frame: Frame): Promise<boolean> {
    await super.processFrame(frame);

    if (this._firstSpeechHandled) {
      return false;
    }

    if (frame instanceof BotStartedSpeakingFrame && this._botStartedSpeakingAt === null) {
      this._botStartedSpeakingAt = this._clock();
    } else if (
      this._botStartedSpeakingAt !== null &&
      this._clock() - this._botStartedSpeakingAt >= this._maxSeconds
    ) {
      this._firstSpeechHandled = true;
    }

    return !this._firstSpeechHandled;
  }
}
