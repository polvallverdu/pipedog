// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/empty_user_turn.py

/** Configuration for recovering from user turns that end without a transcript. */

export const DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT =
  "The user may have said something while you were responding, but it was not " +
  "recognized. Your response was cut off there, and the conversation only includes " +
  "the part they heard, which may be none of it. Briefly ask them to repeat what they said, and " +
  "repeat any question of yours they may have missed.";

export interface EmptyUserTurnConfigOptions {
  /**
   * Developer message for an empty turn that interrupted the bot. `null`
   * leaves such turns unanswered.
   */
  interruptedPrompt?: string | null;
  /**
   * Developer message for an empty turn while the bot was idle. `null` (the
   * default) leaves such turns unanswered.
   */
  idlePrompt?: string | null;
  /**
   * How many empty turns in a row are answered. Further ones are left
   * unanswered until the user says something that is transcribed.
   */
  maxConsecutiveRecoveries?: number;
}

/**
 * How the user aggregator responds to a user turn with no transcript.
 *
 * A user turn can start on voice activity alone and then end with no
 * transcript: a cough, background noise, or speech the STT could not
 * recognize. Nothing is written to the context and the LLM does not run.
 * With this config, the aggregator can append a developer message for such
 * a turn and run the LLM once.
 *
 * Either case may be noise. They differ in what happens if the turn goes
 * unanswered, so each has its own prompt:
 *
 * - Interrupted: the turn started while the bot was thinking, speaking or
 *   running a function call, and cut it off. Unanswered, the bot stays
 *   silent mid-response, so by default the LLM runs and the bot asks the
 *   user to repeat or picks up where it left off. A turn before the bot has
 *   first finished speaking counts as interrupted too.
 * - Idle: the bot had finished and was waiting for the user. The
 *   conversation isn't stuck, and answering what may be noise would be
 *   intrusive, so by default the turn gets no answer.
 *
 * - `interruptedPrompt`: Developer message for an empty turn that interrupted
 *   the bot. `null` leaves such turns unanswered.
 * - `idlePrompt`: Developer message for an empty turn while the bot was idle.
 *   `null` (the default) leaves such turns unanswered.
 * - `maxConsecutiveRecoveries`: How many empty turns in a row are answered.
 *   Further ones are left unanswered until the user says something that is
 *   transcribed.
 */
export class EmptyUserTurnConfig {
  interruptedPrompt: string | null;
  idlePrompt: string | null;
  maxConsecutiveRecoveries: number;

  constructor(options: EmptyUserTurnConfigOptions = {}) {
    this.interruptedPrompt =
      options.interruptedPrompt === undefined
        ? DEFAULT_EMPTY_USER_TURN_INTERRUPTED_PROMPT
        : options.interruptedPrompt;
    this.idlePrompt = options.idlePrompt ?? null;
    this.maxConsecutiveRecoveries = options.maxConsecutiveRecoveries ?? 1;
  }
}
