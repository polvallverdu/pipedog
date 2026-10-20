// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/eager_end_of_turn_mixin.py

/** Mixin for STT services that predict the end of a turn before committing to it. */

import { EagerEndOfTurnCancelFrame, EagerTranscriptionFrame } from "../frames/frames.ts";
import type { FrameProcessor } from "../processors/frame_processor.ts";
import type { Language } from "../transcriptions/language.ts";
import { logger } from "../utils/logger.ts";
import { type Ctor, defineMixin } from "../utils/mixin.ts";
import { timeNowIso8601 } from "../utils/time.ts";
import type { EagerMatchPolicy } from "./user_stop/index.ts";
import {
  EagerUserTurnStrategies,
  ExternalUserTurnStrategies,
  type UserTurnStrategies,
} from "./user_turn_strategies.ts";

/** Options read by EagerEndOfTurnSTTServiceMixin from the constructor options. */
export interface EagerEndOfTurnSTTServiceMixinOptions {
  /**
   * Whether to answer a predicted end of turn ahead of the committed one.
   * Off by default: it spends an inference on every prediction, including the
   * ones the service withdraws.
   */
  enableEagerEndOfTurn?: boolean;
  /**
   * Decides whether the committed transcript is close enough to the predicted
   * one to keep the speculative response. Only consulted while eager end of
   * turn is on. See EagerUserTurnStrategies.
   */
  eagerMatchPolicy?: EagerMatchPolicy | null;
}

/** Members added by EagerEndOfTurnSTTServiceMixin. */
export interface EagerEndOfTurnSTTServiceMixin {
  _enableEagerEndOfTurn: boolean;
  _eagerMatchPolicy: EagerMatchPolicy | null;
  _eagerEndOfTurnPending: boolean;

  /** Whether predicted ends of turn are answered ahead of committed ones. */
  readonly eagerEndOfTurnEnabled: boolean;
  /** Whether a prediction is awaiting a committed end of turn. */
  readonly eagerEndOfTurnPending: boolean;

  recommendedUserTurnStrategies(options: { enableInterruptions: boolean }): UserTurnStrategies;
  _pushEagerEndOfTurn(
    transcript: string,
    options: { userId: string; language?: Language | null; result?: unknown },
  ): Promise<void>;
  _cancelEagerEndOfTurn(): Promise<void>;
  _clearEagerEndOfTurn(): void;
}

/**
 * Adds eager end-of-turn signalling to an STT service that predicts one.
 *
 * Some services report that a turn has probably ended before committing to it,
 * and withdraw the prediction if the user turns out to be mid-sentence. A
 * response can be generated during that gap — see EagerUserTurnStopStrategy,
 * which acts on the frames pushed here. At most one prediction is outstanding
 * at a time, so the frames need not name which one they mean.
 *
 * A service drives the prediction through its own three lifecycle points:
 *
 * @example
 * // the service predicts the turn has ended
 * await this._pushEagerEndOfTurn(transcript, { userId: ..., language: ... });
 *
 * // the user resumed speaking, so the prediction is void
 * await this._cancelEagerEndOfTurn();
 *
 * // the turn was committed, so the prediction is resolved
 * this._clearEagerEndOfTurn();
 *
 * All three are safe to call when no prediction is outstanding, and all three
 * are inert while `enableEagerEndOfTurn` is off, so a service can call them
 * wherever its protocol reports a prediction without guarding each one.
 *
 * The base must be a FrameProcessor (upstream's mixin subclasses it).
 * Upstream: `class XSTTService(EagerEndOfTurnSTTServiceMixin, STTService)`
 * → `class XSTTService extends EagerEndOfTurnSTTServiceMixin(STTService)`.
 */
export const EagerEndOfTurnSTTServiceMixin = defineMixin<
  EagerEndOfTurnSTTServiceMixin,
  <B extends Ctor>(base: B) => B & Ctor<EagerEndOfTurnSTTServiceMixin>
>("EagerEndOfTurnSTTServiceMixin", <B extends Ctor>(Base: B) => {
  const FrameProcessorBase = Base as unknown as Ctor<FrameProcessor>;
  abstract class EagerEndOfTurnSTTServiceMixinImpl
    extends FrameProcessorBase
    implements EagerEndOfTurnSTTServiceMixin
  {
    _enableEagerEndOfTurn: boolean;
    _eagerMatchPolicy: EagerMatchPolicy | null;
    _eagerEndOfTurnPending = false;

    constructor(...args: any[]) {
      super(...args);
      const options = (args[0] ?? {}) as EagerEndOfTurnSTTServiceMixinOptions;
      this._enableEagerEndOfTurn = options.enableEagerEndOfTurn ?? false;
      this._eagerMatchPolicy = options.eagerMatchPolicy ?? null;
    }

    get eagerEndOfTurnEnabled(): boolean {
      return this._enableEagerEndOfTurn;
    }

    get eagerEndOfTurnPending(): boolean {
      return this._eagerEndOfTurnPending;
    }

    /**
     * Build the turn strategies this service recommends.
     *
     * Both recommendations leave turn detection to the service. The eager one
     * additionally answers a predicted end of turn, which only makes sense for
     * a service configured to report one.
     *
     * @param options.enableInterruptions Whether a proposal starting a turn
     *   should interrupt the bot.
     * @returns Strategies for the caller's `STTMetadataFrame`.
     */
    recommendedUserTurnStrategies(options: { enableInterruptions: boolean }): UserTurnStrategies {
      if (!this._enableEagerEndOfTurn) {
        return new ExternalUserTurnStrategies({
          enableInterruptions: options.enableInterruptions,
        });
      }

      return new EagerUserTurnStrategies({
        matchPolicy: this._eagerMatchPolicy,
        enableInterruptions: options.enableInterruptions,
      });
    }

    /**
     * Report that the turn has probably ended.
     *
     * @param transcript What the service heard for the turn so far.
     * @param options.userId Identifier for the user who spoke.
     * @param options.language Detected or specified language of the speech.
     * @param options.result Raw result from the STT service.
     */
    async _pushEagerEndOfTurn(
      transcript: string,
      options: { userId: string; language?: Language | null; result?: unknown },
    ): Promise<void> {
      if (!this._enableEagerEndOfTurn) return;

      this._eagerEndOfTurnPending = true;
      logger.trace(`${this}: eager end of turn: [${transcript}]`);
      await this.pushFrame(
        new EagerTranscriptionFrame({
          text: transcript,
          userId: options.userId,
          timestamp: timeNowIso8601(),
          language: options.language ?? null,
          result: options.result ?? null,
        }),
      );
    }

    /** Withdraw the prediction. */
    async _cancelEagerEndOfTurn(): Promise<void> {
      if (!this._eagerEndOfTurnPending) return;

      logger.trace(`${this}: eager end of turn withdrawn`);
      this._eagerEndOfTurnPending = false;
      await this.pushFrame(new EagerEndOfTurnCancelFrame());
    }

    /**
     * Resolve the prediction without withdrawing it.
     *
     * Called when the turn is committed: whatever was generated from the
     * prediction is settled by the committed transcript, not by this.
     */
    _clearEagerEndOfTurn(): void {
      this._eagerEndOfTurnPending = false;
    }
  }
  return EagerEndOfTurnSTTServiceMixinImpl as unknown as B & Ctor<EagerEndOfTurnSTTServiceMixin>;
});
