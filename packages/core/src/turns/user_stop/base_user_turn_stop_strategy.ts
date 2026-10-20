// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/base_user_turn_stop_strategy.py

/** Base user turn stop strategy for determining when the user stopped speaking. */

import type { Frame } from "../../frames/frames.ts";
import { FrameDirection, type FrameProcessorSetup } from "../../processors/frame_processor.ts";
import { BaseObject, type BaseObjectOptions } from "../../utils/base_object.ts";
import type { ProcessFrameResult, UserTurnSpeculation } from "../types.ts";

export interface UserTurnStoppedParamsOptions {
  /**
   * Whether to emit `UserStoppedSpeakingFrame` for this turn. False when the
   * turn end was already announced elsewhere — by a shared
   * `UserTurnProcessor`, or by a service that emits turn frames rather than
   * proposing them.
   */
  enableUserSpeakingFrames: boolean;
  /**
   * Whether this turn end confirms a speculative response that was already
   * generated. The aggregator then writes the turn to the context without
   * running inference again, since the answer is already on its way.
   */
  confirmsSpeculation?: boolean;
}

/**
 * Parameters emitted when a user turn stops.
 *
 * These parameters are passed to the `on_user_turn_stopped` event and provide
 * contextual information about how the end of user turn should be handled by
 * the user aggregator.
 *
 * - `enableUserSpeakingFrames`: Whether to emit `UserStoppedSpeakingFrame`
 *   for this turn. False when the turn end was already announced elsewhere.
 * - `confirmsSpeculation`: Whether this turn end confirms a speculative
 *   response that was already generated.
 */
export class UserTurnStoppedParams {
  enableUserSpeakingFrames: boolean;
  confirmsSpeculation: boolean;

  constructor(options: UserTurnStoppedParamsOptions) {
    this.enableUserSpeakingFrames = options.enableUserSpeakingFrames;
    this.confirmsSpeculation = options.confirmsSpeculation ?? false;
  }
}

export interface BaseUserTurnStopStrategyOptions extends BaseObjectOptions {}

export interface TriggerUserTurnStoppedOptions {
  /**
   * Whether to emit `UserStoppedSpeakingFrame` for this turn. Pass false when
   * something else in the pipeline has already emitted it.
   */
  enableUserSpeakingFrames?: boolean | null;
}

export interface TriggerUserTurnInferenceTriggeredOptions {
  /**
   * Set to run this inference speculatively, against a provisional context
   * carrying the turn text it names, for a turn that hasn't ended yet. The
   * response it produces is held back until the turn is confirmed. Leave null
   * to run the inference against the conversation as it stands.
   */
  speculation?: UserTurnSpeculation | null;
}

export interface TriggerUserTurnFinalizedOptions extends TriggerUserTurnStoppedOptions {
  /**
   * Whether a response generated ahead of this turn ending already answers
   * it, so inference should not run again.
   */
  confirmsSpeculation?: boolean;
}

/**
 * Base class for strategies that determine when the user stops speaking.
 *
 * Subclasses should implement logic to detect when the user stops
 * speaking. This could be based on analyzing incoming frames (such as
 * transcriptions), conversation state, or other heuristics.
 *
 * Events triggered by strategies:
 *
 *   - `on_push_frame`: Indicates the strategy wants to push a frame.
 *   - `on_user_turn_inference_triggered`: Signals that enough evidence
 *     exists to start LLM inference for the current user turn, carrying a
 *     `UserTurnSpeculation` when the turn it answers hasn't ended yet. In
 *     most cases this fires together with `on_user_turn_stopped`. Strategies
 *     that gate finalization on the LLM (e.g.
 *     `LLMTurnCompletionUserTurnStopStrategy`) fire only this event
 *     upstream and a separate strategy fires `on_user_turn_stopped` once
 *     the LLM confirms the turn is complete.
 *   - `on_user_turn_stopped`: Signals that the user turn is semantically
 *     final. Observers, transcript appenders, and UI indicators should
 *     bind this event.
 *
 * Porting note: the deprecated `enable_user_speaking_frames` constructor
 * argument and the deprecated `reset()` hook are not ported.
 */
export class BaseUserTurnStopStrategy extends BaseObject {
  protected _enableUserSpeakingFrames = true;

  constructor(options: BaseUserTurnStopStrategyOptions = {}) {
    super(options);
    this._registerEventHandler("on_push_frame", true);
    this._registerEventHandler("on_broadcast_frame", true);
    this._registerEventHandler("on_user_turn_inference_triggered", true);
    this._registerEventHandler("on_user_turn_speculation_cancelled", true);
    this._registerEventHandler("on_user_turn_stopped", true);
  }

  /**
   * Whether this strategy resolves proposals into turn stops.
   *
   * A `ProposedUserStoppedSpeakingFrame` is a request for a decision, so a
   * strategy that acts on one consumes it: the frame stops travelling, and no
   * resolver further along decides the same turn a second time. Override to
   * true in a strategy that handles that frame — including one that holds the
   * proposal for a while before deciding.
   */
  get resolvesProposedTurnStopFrames(): boolean {
    return false;
  }

  /**
   * Set up the strategy.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup.taskManager);
  }

  /** Cleanup the strategy. */
  override async cleanup(): Promise<void> {}

  /**
   * Notify the strategy that a user turn has started.
   *
   * The controller calls this on every stop strategy when a turn begins.
   * Override to run, for example, logic to arm the strategy to detect the
   * end of the turn now in progress.
   */
  async handleUserTurnStarted(): Promise<void> {}

  /**
   * Notify the strategy that the user turn has stopped.
   *
   * The controller calls this on every stop strategy when a turn ends,
   * regardless of which strategy (or the stop watchdog timeout) ended it.
   * Override to run stop-specific logic — e.g. dropping a turn analyzer's
   * buffered speech that must not survive an externally-ended turn.
   */
  async handleUserTurnStopped(): Promise<void> {}

  /**
   * Process an incoming frame to decide whether the user stopped speaking.
   *
   * Subclasses should override this to implement logic that decides whether
   * the user has stopped speaking.
   *
   * @param frame The frame to be analyzed.
   * @returns A ProcessFrameResult indicating the outcome, or null (treated as
   *   CONTINUE for backward compatibility).
   */
  async processFrame(_frame: Frame): Promise<ProcessFrameResult | null> {
    return null;
  }

  /**
   * Emit on_push_frame to push a frame using the user aggregator.
   *
   * @param frame The frame to be pushed.
   * @param direction What direction the frame should be pushed to.
   */
  async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    await this._callEventHandler("on_push_frame", frame, direction);
  }

  /**
   * Emit on_broadcast_frame to broadcast a frame using the user aggregator.
   *
   * @param frameCls The class of the frame to be broadcasted.
   * @param options Options to be passed to the frame's constructor.
   */
  async broadcastFrame<O>(frameCls: new (options: O) => Frame, options?: O): Promise<void> {
    await this._callEventHandler("on_broadcast_frame", frameCls, options);
  }

  /**
   * Withdraw the speculation this strategy has in flight.
   *
   * Emitted rather than pushed so the host broadcasts it the same way it
   * broadcasts the turn end. A withdrawal that took the queued path would
   * reach a downstream gate *after* the turn end that follows it, and the
   * gate would release the response the withdrawal was meant to discard.
   */
  async triggerUserTurnSpeculationCancelled(): Promise<void> {
    await this._callEventHandler("on_user_turn_speculation_cancelled");
  }

  /**
   * Fire both `on_user_turn_inference_triggered` and `on_user_turn_stopped`.
   *
   * Most strategies call this when they decide a turn has ended. To
   * defer finalization to another strategy (so this strategy fires
   * only the inference-triggered event), wrap this strategy with
   * `deferred()` instead of changing the trigger call.
   */
  async triggerUserTurnStopped(options: TriggerUserTurnStoppedOptions = {}): Promise<void> {
    await this.triggerUserTurnInferenceTriggered();
    await this.triggerUserTurnFinalized({
      enableUserSpeakingFrames: options.enableUserSpeakingFrames ?? null,
    });
  }

  /** Trigger only the `on_user_turn_inference_triggered` event. */
  async triggerUserTurnInferenceTriggered(
    options: TriggerUserTurnInferenceTriggeredOptions = {},
  ): Promise<void> {
    await this._callEventHandler("on_user_turn_inference_triggered", options.speculation ?? null);
  }

  /** Trigger only the `on_user_turn_stopped` event. */
  async triggerUserTurnFinalized(options: TriggerUserTurnFinalizedOptions = {}): Promise<void> {
    await this._callEventHandler(
      "on_user_turn_stopped",
      new UserTurnStoppedParams({
        enableUserSpeakingFrames:
          options.enableUserSpeakingFrames ?? this._enableUserSpeakingFrames,
        confirmsSpeculation: options.confirmsSpeculation ?? false,
      }),
    );
  }
}
