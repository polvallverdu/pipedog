// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/types.py

/** Shared types for user turn strategy frame processing. */

/**
 * Result of processing a frame in a user turn strategy.
 *
 * Controls whether the strategy loop in the controller continues to the
 * next strategy or stops early.
 *
 * - CONTINUE: Continue to the next strategy in the loop.
 * - STOP: Stop evaluating further strategies for this frame.
 */
export const ProcessFrameResult = {
  CONTINUE: "continue",
  STOP: "stop",
} as const;
export type ProcessFrameResult = (typeof ProcessFrameResult)[keyof typeof ProcessFrameResult];

export interface UserTurnSpeculationOptions {
  /** The user turn text the inference was run against. */
  text: string;
}

/**
 * A speculative inference a stop strategy has in flight.
 *
 * Produced from an eager end of turn: the turn is not over yet, so the
 * inference runs against a provisional context and its response is held back
 * until the turn is confirmed.
 *
 * - `text`: The user turn text the inference was run against.
 */
export class UserTurnSpeculation {
  text: string;

  constructor(options: UserTurnSpeculationOptions) {
    this.text = options.text;
  }
}
