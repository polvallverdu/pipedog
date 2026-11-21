// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// What the page's pipeline strip shows that RTVI doesn't carry, sent as RTVI server messages:
//
//   vad            Silero heard the user start or stop speaking (RTVI's user-started/stopped-speaking
//                  are the turn, which starts later, or not at all over the bot)
//   turn-decided   how long after the user stopped the turn was judged over, and by what
//   interrupted    the user took the turn while the bot was speaking
//   turn-ignored   speech over the bot that didn't interrupt it, and why: background speech VAD
//                  didn't hear, a backchannel, or too few words
//
// The last one comes from the start strategy itself (`DemoMinWordsUserTurnStartStrategy`), the
// only place that knows why a transcript didn't start a turn; the others from an observer.

import { time } from "@pipedog/asyncio";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type InterimTranscriptionFrame,
  type TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { BaseObserver, type FramePushed } from "@pipedog/core/observers/base_observer";
import { MinWordsUserTurnStartStrategy } from "@pipedog/core/turns/user_start/index";
import type { MinWordsUserTurnStartStrategyOptions } from "@pipedog/core/turns/user_start/min_words_user_turn_start_strategy";

/** Why speech over the bot didn't interrupt it. */
export type IgnoredReason = "background" | "backchannel" | "too_few_words";

export interface IgnoredSpeech {
  reason: IgnoredReason;
  /** What the STT heard, cut to a short preview. */
  text: string;
}

/** Report an utterance once, not once per interim transcript. */
const IGNORED_REPEAT_SECS = 2;
const PREVIEW_CHARS = 60;

export interface DemoMinWordsOptions extends MinWordsUserTurnStartStrategyOptions {
  /** Called when speech over the bot is kept from interrupting it. */
  onIgnored?: (ignored: IgnoredSpeech) => Promise<void>;
}

/**
 * `MinWordsUserTurnStartStrategy`, reporting the transcripts it keeps from interrupting the bot.
 * The decision itself is the base class's; this only says why it went the way it did.
 */
export class DemoMinWordsUserTurnStartStrategy extends MinWordsUserTurnStartStrategy {
  readonly #onIgnored: (ignored: IgnoredSpeech) => Promise<void>;
  #lastReason: IgnoredReason | null = null;
  #lastAt = 0;

  constructor(options: DemoMinWordsOptions) {
    super(options);
    this.#onIgnored = options.onIgnored ?? (async () => {});
  }

  /** Why `text`, heard over the bot, can't start a turn; null when it can (or the bot is quiet). */
  ignoredReason(text: string, frame: TranscriptionFrame | InterimTranscriptionFrame) {
    if (!this._botSpeaking) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    const why = this._ignoredOverBot(trimmed, frame.language);
    if (why === "backchannel") return "backchannel";
    // Too few words first: the user's own first word over the bot can come before VAD has
    // confirmed their speech, and it wouldn't interrupt either way. Background speech is words
    // enough to interrupt, with no speech VAD accepted behind them.
    if (trimmed.split(/\s+/).length < this._minWords) return "too_few_words";
    return why !== null ? "background" : null;
  }

  protected override async _handleTranscription(
    frame: TranscriptionFrame | InterimTranscriptionFrame,
  ): Promise<void> {
    const reason = this.ignoredReason(frame.text, frame);
    await super._handleTranscription(frame);
    if (reason === null) return;
    const now = time();
    if (reason === this.#lastReason && now - this.#lastAt < IGNORED_REPEAT_SECS) {
      this.#lastAt = now;
      return;
    }
    this.#lastReason = reason;
    this.#lastAt = now;
    await this.#onIgnored({ reason, text: frame.text.trim().slice(0, PREVIEW_CHARS) });
  }
}

/** A message for the page, sent as an RTVI server message. */
export type PipelineEvent =
  | { type: "vad"; speaking: boolean }
  | { type: "turn-decided"; ms: number; by: string }
  | { type: "interrupted" };

/**
 * Watches the frames for what the strip shows besides RTVI's own events: VAD, how long the turn
 * took to decide, and interruptions.
 */
export class PipelineEventsObserver extends BaseObserver {
  readonly #send: (event: PipelineEvent) => Promise<void>;
  readonly #decidedBy: string;
  #botSpeaking = false;
  /** When the user's speech ended (VAD's stop, minus its stop delay), in `time()` seconds. */
  #speechEndedAt: number | null = null;

  /**
   * @param decidedBy What decides the end of the turn, for the page ("Flux", "Smart Turn").
   * @param send Delivers an event to the page.
   */
  constructor(decidedBy: string, send: (event: PipelineEvent) => Promise<void>) {
    super({ observeEveryPush: false });
    this.#decidedBy = decidedBy;
    this.#send = send;
  }

  override async onPushFrame(data: FramePushed): Promise<void> {
    const frame = data.frame;
    if (frame instanceof VADUserStartedSpeakingFrame) {
      this.#speechEndedAt = null;
      await this.#send({ type: "vad", speaking: true });
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      this.#speechEndedAt = frame.timestamp - frame.stopSecs;
      await this.#send({ type: "vad", speaking: false });
    } else if (frame instanceof BotStartedSpeakingFrame) {
      this.#botSpeaking = true;
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      this.#botSpeaking = false;
    } else if (frame instanceof UserStartedSpeakingFrame) {
      if (this.#botSpeaking) await this.#send({ type: "interrupted" });
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      const endedAt = this.#speechEndedAt;
      this.#speechEndedAt = null;
      if (endedAt !== null) {
        const ms = Math.max(0, Math.round((time() - endedAt) * 1000));
        await this.#send({ type: "turn-decided", ms, by: this.#decidedBy });
      }
    }
  }
}
