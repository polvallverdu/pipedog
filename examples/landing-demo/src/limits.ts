// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The per-session limits: a hard maximum length, an idle timeout (no one has spoken for a while),
// and a maximum number of user turns. `SessionLimits` decides; `SessionLimitsObserver` feeds it
// the pipeline's speaking frames.

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { BaseObserver, type FramePushed } from "@pipedog/core/observers/base_observer";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import type { SessionLimitsConfig } from "./config.ts";

export type EndReason = "time" | "idle" | "turns" | "goodbye";

/** What the bot says as it ends a session, by reason. */
export const GOODBYES: Record<EndReason, string> = {
  time: "That's our two minutes. Thanks for trying pipedog, and have a great day!",
  idle: "It's gone quiet, so I'll hang up. Thanks for trying pipedog!",
  turns: "That's all the questions this demo takes. Thanks for trying pipedog!",
  goodbye: "Thanks for trying pipedog. Bye!",
};

/** Seconds before the hard limit at which the bot starts saying goodbye. */
export const GOODBYE_LEAD_SECS = 6;

/**
 * The limits' state machine. Times are in seconds, from any monotonic clock.
 *
 * - time: at `maxSecs - GOODBYE_LEAD_SECS` after the start, so the goodbye fits.
 * - idle: `idleSecs` with neither side speaking (the bot speaking or the user mid-turn counts as
 *   activity).
 * - turns: once the user has finished `maxTurns` turns, after the bot's reply to the last one.
 */
export class SessionLimits {
  readonly #config: SessionLimitsConfig;
  readonly #startedAt: number;
  #lastActivity: number;
  #userSpeaking = false;
  #botSpeaking = false;
  #turns = 0;
  #ended: EndReason | null = null;

  constructor(config: SessionLimitsConfig, now: number) {
    this.#config = config;
    this.#startedAt = now;
    this.#lastActivity = now;
  }

  get turns(): number {
    return this.#turns;
  }

  get ended(): EndReason | null {
    return this.#ended;
  }

  /** Seconds left before the hard limit. */
  remainingSecs(now: number): number {
    return Math.max(0, this.#config.maxSecs - (now - this.#startedAt));
  }

  userStarted(now: number): void {
    this.#userSpeaking = true;
    this.#lastActivity = now;
  }

  userStopped(now: number): void {
    this.#userSpeaking = false;
    this.#turns += 1;
    this.#lastActivity = now;
  }

  botStarted(now: number): void {
    this.#botSpeaking = true;
    this.#lastActivity = now;
  }

  /** The bot finished speaking: returns "turns" if that was the reply to the last turn allowed. */
  botStopped(now: number): EndReason | null {
    this.#botSpeaking = false;
    this.#lastActivity = now;
    if (this.#turns >= this.#config.maxTurns) return this.end("turns");
    return null;
  }

  /** Check the clock: returns the reason to end now, once. */
  tick(now: number): EndReason | null {
    if (this.#ended) return null;
    if (now - this.#startedAt >= this.#config.maxSecs - GOODBYE_LEAD_SECS) return this.end("time");
    const quiet = !this.#userSpeaking && !this.#botSpeaking;
    if (quiet && now - this.#lastActivity >= this.#config.idleSecs) return this.end("idle");
    return null;
  }

  /** Mark the session as ending, for `reason`, if it isn't already. */
  end(reason: EndReason): EndReason | null {
    if (this.#ended) return null;
    this.#ended = reason;
    return reason;
  }
}

/** Feeds a `SessionLimits` from the frames the pipeline pushes. */
export class SessionLimitsObserver extends BaseObserver {
  readonly #limits: SessionLimits;
  readonly #now: () => number;
  readonly #onEnd: (reason: EndReason) => Promise<void>;

  constructor(
    limits: SessionLimits,
    now: () => number,
    onEnd: (reason: EndReason) => Promise<void>,
  ) {
    super({ observeEveryPush: false });
    this.#limits = limits;
    this.#now = now;
    this.#onEnd = onEnd;
  }

  override async onPushFrame(data: FramePushed): Promise<void> {
    if (data.direction !== FrameDirection.DOWNSTREAM) return;
    const frame = data.frame;
    const now = this.#now();
    if (frame instanceof UserStartedSpeakingFrame) {
      this.#limits.userStarted(now);
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      this.#limits.userStopped(now);
    } else if (frame instanceof BotStartedSpeakingFrame) {
      this.#limits.botStarted(now);
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      const reason = this.#limits.botStopped(now);
      if (reason) await this.#onEnd(reason);
    }
  }
}
