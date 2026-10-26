// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** User mute strategy that mutes the user once the conversation is ending. */

import { EndWorkerFrame, type Frame, StopWorkerFrame } from "../../frames/frames.ts";
import {
  BaseUserMuteStrategy,
  type BaseUserMuteStrategyOptions,
} from "./base_user_mute_strategy.ts";

export interface EndingUserMuteStrategyOptions extends BaseUserMuteStrategyOptions {
  /**
   * Returns true once the conversation is ending. Use it when the end is
   * decided where this strategy can't see it (e.g. a tool queues a goodbye and
   * an `EndFrame`, which mute strategies never receive).
   */
  isEnding?: () => boolean;
}

/**
 * User mute strategy that mutes the user for the rest of the conversation once
 * it is ending, so talking over the bot's last words (a goodbye) neither cuts
 * them off nor starts a new turn.
 *
 * The strategy mutes, and stays muted, after it sees an `EndWorkerFrame` or a
 * `StopWorkerFrame` (for example one queued with the worker, which travels
 * through the user aggregator), or once `isEnding()` returns true. `EndFrame`
 * itself is never shown to mute strategies, and arrives after the last words
 * have been queued, so it can't be the trigger.
 */
export class EndingUserMuteStrategy extends BaseUserMuteStrategy {
  protected _isEnding: (() => boolean) | null;
  protected _ending = false;

  constructor(options: EndingUserMuteStrategyOptions = {}) {
    super(options);
    this._isEnding = options.isEnding ?? null;
  }

  /** Mute from now on, as if the conversation had been seen ending. */
  end(): void {
    this._ending = true;
  }

  /**
   * Process an incoming frame.
   *
   * @param frame The frame to be processed.
   * @returns Whether the strategy is muted.
   */
  override async processFrame(frame: Frame): Promise<boolean> {
    await super.processFrame(frame);

    if (frame instanceof EndWorkerFrame || frame instanceof StopWorkerFrame) {
      this._ending = true;
    } else if (!this._ending && this._isEnding?.()) {
      this._ending = true;
    }

    return this._ending;
  }
}
