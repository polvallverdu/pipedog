// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/types.py

/**
 * Shared types for user turn strategy frame processing.
 *
 * Porting note: the deprecated `ProcessFrameResult` is not ported; strategies
 * return nothing from `processFrame()`, and `StrategyMode` says how they combine.
 */

import type { PerceptionSignal } from "../expressive/perception.ts";

export interface UserTurnSpeculationOptions {
  /** The user turn text the inference was run against. */
  text: string;
  /**
   * How the user said it, as read at the eager end of turn, or null. Part of
   * expressive conversation (alpha).
   */
  perception?: PerceptionSignal[] | null;
}

/**
 * A speculative inference a stop strategy has in flight.
 *
 * Produced from an eager end of turn: the turn is not over yet, so the
 * inference runs against a provisional context and its response is held back
 * until the turn is confirmed.
 *
 * - `text`: The user turn text the inference was run against.
 * - `perception`: How the user said it, as read at the eager end of turn,
 *   or null. Part of expressive conversation (alpha).
 */
export class UserTurnSpeculation {
  text: string;
  perception: PerceptionSignal[] | null;

  constructor(options: UserTurnSpeculationOptions) {
    this.text = options.text;
    this.perception = options.perception ?? null;
  }
}

export interface UserTurnResumedParamsOptions {
  /** Whether the turn interrupts the bot, as decided when it started. */
  enableInterruptions: boolean;
  /**
   * Whether the turn's inference was already triggered. The new speech voids
   * the answer it started.
   */
  inferenceTriggered: boolean;
}

/**
 * Parameters emitted when the user speaks again in an open turn.
 *
 * - `enableInterruptions`: Whether the turn interrupts the bot, as decided
 *   when it started.
 * - `inferenceTriggered`: Whether the turn's inference was already
 *   triggered. The new speech voids the answer it started.
 */
export class UserTurnResumedParams {
  enableInterruptions: boolean;
  inferenceTriggered: boolean;

  constructor(options: UserTurnResumedParamsOptions) {
    this.enableInterruptions = options.enableInterruptions;
    this.inferenceTriggered = options.inferenceTriggered;
  }
}
