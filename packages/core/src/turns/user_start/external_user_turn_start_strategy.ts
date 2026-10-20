// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_start/external_user_turn_start_strategy.py

/** User turn start strategy driven by another component in the pipeline. */

import {
  type Frame,
  ProposedUserStartedSpeakingFrame,
  UserStartedSpeakingFrame,
} from "../../frames/frames.ts";
import { logger } from "../../utils/logger.ts";
import { ProcessFrameResult } from "../types.ts";
import {
  BaseUserTurnStartStrategy,
  type BaseUserTurnStartStrategyOptions,
} from "./base_user_turn_start_strategy.ts";

export interface ExternalUserTurnStartStrategyOptions extends BaseUserTurnStartStrategyOptions {
  /**
   * If true, broadcast an interruption when a proposal opens a turn. Ignored
   * on the adopt path, where the emitter has already broadcast one.
   */
  enableInterruptions?: boolean;
}

/**
 * User turn start strategy driven by another component in the pipeline.
 *
 * Rather than detecting the start of a turn itself, this strategy takes its
 * cue from another processor. It understands two signals, which differ in how
 * much the emitter has already done:
 *
 * - `ProposedUserStartedSpeakingFrame` — a service with its own turn detection
 *   proposing a turn boundary. This strategy makes the decision, emitting the
 *   `UserStartedSpeakingFrame` and broadcasting the interruption itself.
 *   Subclass it to adjust when, or whether, a proposal opens a turn.
 *
 * - `UserStartedSpeakingFrame` — the turn was already decided and announced
 *   elsewhere, typically by a shared `UserTurnProcessor` fanning turns out to
 *   several aggregators. This strategy adopts that decision and emits nothing,
 *   so the turn isn't announced twice.
 *
 * A service that emits turn frames directly lands on the adopt path and keeps
 * working, but it owns the interruption logic itself. Emitting proposals
 * instead hands that job back to the pipeline.
 */
export class ExternalUserTurnStartStrategy extends BaseUserTurnStartStrategy {
  constructor(options: ExternalUserTurnStartStrategyOptions = {}) {
    super({ ...options, enableInterruptions: options.enableInterruptions ?? true });
  }

  /** Whether this strategy resolves proposals into turn starts. */
  override get resolvesProposedTurnStartFrames(): boolean {
    return true;
  }

  /**
   * Process an incoming frame to detect user turn start.
   *
   * @param frame The frame to be analyzed.
   * @returns STOP if the turn started, CONTINUE otherwise.
   */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof ProposedUserStartedSpeakingFrame) {
      logger.debug(`${this}: resolving a proposed user turn start`);
      await this.triggerUserTurnStarted();
      return ProcessFrameResult.STOP;
    }

    if (frame instanceof UserStartedSpeakingFrame) {
      // Already announced elsewhere — adopt the decision without repeating it.
      logger.debug(`${this}: adopting a user turn start decided elsewhere`);
      await this.triggerUserTurnStarted({
        enableInterruptions: false,
        enableUserSpeakingFrames: false,
      });
      return ProcessFrameResult.STOP;
    }

    return ProcessFrameResult.CONTINUE;
  }
}
