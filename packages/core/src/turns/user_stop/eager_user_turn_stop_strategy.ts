// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/eager_user_turn_stop_strategy.py

/** User turn stop strategy that answers an eager end of turn speculatively. */

import { sleep, type Task } from "@pipecat-ts/asyncio";
import {
  EagerEndOfTurnCancelFrame,
  EagerTranscriptionFrame,
  type Frame,
} from "../../frames/frames.ts";
import { logger } from "../../utils/logger.ts";
import { type ProcessFrameResult, UserTurnSpeculation } from "../types.ts";
import type { TriggerUserTurnStoppedOptions } from "./base_user_turn_stop_strategy.ts";
import { type EagerMatchPolicy, NormalizedMatch } from "./eager_match_policy.ts";
import {
  ExternalUserTurnStopStrategy,
  type ExternalUserTurnStopStrategyOptions,
} from "./external_user_turn_stop_strategy.ts";

export interface EagerUserTurnStopStrategyOptions extends ExternalUserTurnStopStrategyOptions {
  /**
   * Decides whether the committed transcript is close enough to the eager one
   * to keep the speculative response. Defaults to `NormalizedMatch`, which
   * ignores the capitalization and punctuation services commonly add when
   * they commit a transcript. Pass `ExactMatch` to require the two to be
   * identical.
   */
  matchPolicy?: EagerMatchPolicy | null;
  /**
   * Seconds a prediction may go unresolved before it is withdrawn. A service
   * that stops sending turn signals mid-speculation would otherwise leave the
   * response held and the bot silent for the rest of the session.
   */
  speculationTimeout?: number;
}

/**
 * Answers an eager end of turn while the turn is still open.
 *
 * Some STT services predict the end of a turn before committing to it, and
 * withdraw the prediction if the user turns out to be mid-sentence. This
 * strategy starts generating a response on that prediction, so the gap between
 * it and the committed end of turn is spent generating rather than waiting.
 *
 * The prediction can be wrong in three ways, and each withdraws the response:
 *
 * - the user resumes speaking, and the service withdraws the eager end of turn
 * - the committed transcript differs from the eager one, per `matchPolicy`
 * - the turn never commits within `speculationTimeout`
 *
 * Every one of those leaves as an `EagerEndOfTurnCancelFrame` from here, so a
 * response is never dropped somewhere the rest of the pipeline cannot see.
 *
 * Nothing the speculation produces reaches the user or the context. The
 * inference runs against a provisional context, and its response is held by
 * the LLM service's `SpeculationGate` until the turn is confirmed. The turn
 * ends normally: the user message written to the context is always the
 * committed transcript, never the eager one.
 *
 * Install it with `EagerUserTurnStrategies` rather than directly — the
 * service owns turn detection here, so it replaces the detector chain instead
 * of running alongside it.
 */
export class EagerUserTurnStopStrategy extends ExternalUserTurnStopStrategy {
  protected _matchPolicy: EagerMatchPolicy;
  protected _speculationTimeout: number;
  protected _speculationTimeoutTask: Task<unknown> | null = null;
  protected _speculation: UserTurnSpeculation | null = null;

  constructor(options: EagerUserTurnStopStrategyOptions = {}) {
    super(options);
    this._matchPolicy = options.matchPolicy ?? new NormalizedMatch();
    this._speculationTimeout = options.speculationTimeout ?? 5.0;
  }

  /** The policy deciding whether a speculative response still applies. */
  get matchPolicy(): EagerMatchPolicy {
    return this._matchPolicy;
  }

  /**
   * Start a speculation on an eager end of turn, or withdraw one.
   *
   * @param frame The frame to be analyzed.
   * @returns Always CONTINUE, so subsequent stop strategies are evaluated.
   */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof EagerTranscriptionFrame) {
      await this._speculate(frame);
    } else if (frame instanceof EagerEndOfTurnCancelFrame) {
      // The service withdrew its prediction, and its frame reaches every
      // consumer on its own. Only our own state is left to clear.
      await this._forget();
    }

    return await super.processFrame(frame);
  }

  /** End the turn, keeping the speculative response only if it still applies. */
  override async triggerUserTurnStopped(
    options: TriggerUserTurnStoppedOptions = {},
  ): Promise<void> {
    const enableUserSpeakingFrames = options.enableUserSpeakingFrames ?? null;
    const speculation = await this._takeSpeculation();
    if (!speculation) {
      await super.triggerUserTurnStopped({ enableUserSpeakingFrames });
      return;
    }

    if (this._matchPolicy.matches(speculation.text, this._text)) {
      logger.debug(`${this}: eager end of turn held, keeping the speculative response`);
      // Inference already ran, on the eager transcript. Only finalize:
      // the UserStoppedSpeakingFrame it emits is what releases the
      // response, and the flag stops a second inference answering the
      // same turn.
      await this.triggerUserTurnFinalized({
        enableUserSpeakingFrames,
        confirmsSpeculation: true,
      });
      return;
    }

    logger.debug(
      `${this}: eager end of turn missed, discarding the speculative response ` +
        `(eager: [${speculation.text}], committed: [${this._text}])`,
    );
    await this.triggerUserTurnSpeculationCancelled();
    // Inference has to run again, on the committed transcript, so fire both
    // events rather than just finalizing.
    await super.triggerUserTurnStopped({ enableUserSpeakingFrames });
  }

  /** Clear per-turn state. Runs at both turn boundaries. */
  protected override async _reset(): Promise<void> {
    const speculation = await this._takeSpeculation();
    await super._reset();
    if (speculation) {
      // The turn ended without resolving the speculation — the stop
      // watchdog, an interruption, session end. Nothing else will withdraw
      // it, so the response would be held until the gate times out.
      logger.debug(`${this}: turn ended unresolved, discarding the speculative response`);
      await this.triggerUserTurnSpeculationCancelled();
    }
  }

  /** Answer an eager end of turn, leaving the turn open. */
  protected async _speculate(frame: EagerTranscriptionFrame): Promise<void> {
    // Segments committed earlier in this turn are part of what the LLM will
    // see, so they're part of what the committed transcript is compared to.
    const speculation = new UserTurnSpeculation({ text: this._text + frame.text });
    this._speculation = speculation;
    this._speculationTimeoutTask = this.taskManager.createTask(
      () => this._speculationTimeoutHandler(speculation),
      `${this}::_speculation_timeout_handler`,
    );
    logger.debug(`${this}: speculating on eager end of turn: [${speculation.text}]`);
    await this.triggerUserTurnInferenceTriggered({ speculation });
  }

  /** Withdraw a prediction the turn never resolved. */
  protected async _speculationTimeoutHandler(speculation: UserTurnSpeculation): Promise<void> {
    await sleep(this._speculationTimeout);
    // Cleared here rather than by a cancellation, since this timer fired.
    this._speculationTimeoutTask = null;

    if (this._speculation !== speculation) {
      return;
    }

    logger.debug(
      `${this}: eager end of turn unresolved after ${this._speculationTimeout}s, ` +
        "discarding the speculative response",
    );
    this._speculation = null;
    await this.triggerUserTurnSpeculationCancelled();
  }

  /**
   * Take the speculation in flight, stopping the clock on it.
   *
   * The single exit, so a resolved speculation can never be withdrawn again
   * by a timer still running for it.
   */
  protected async _takeSpeculation(): Promise<UserTurnSpeculation | null> {
    const speculation = this._speculation;
    this._speculation = null;
    if (this._speculationTimeoutTask) {
      const task = this._speculationTimeoutTask;
      this._speculationTimeoutTask = null;
      await this.cancelTask(task);
    }
    return speculation;
  }

  /** Drop a speculation the service withdrew. */
  protected async _forget(): Promise<void> {
    await this._takeSpeculation();
  }
}
