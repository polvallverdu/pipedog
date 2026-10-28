// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_stop/base_user_turn_stop_strategy.py

/** Base user turn stop strategy for determining when the user stopped speaking. */

import type { Frame } from "../../frames/frames.ts";
import { FrameDirection, type FrameProcessorSetup } from "../../processors/frame_processor.ts";
import { BaseObject, type BaseObjectOptions } from "../../utils/base_object.ts";
import type { UserTurnSpeculation } from "../types.ts";

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

export interface ReportUserTurnStoppedOptions {
  /**
   * Whether to emit `UserStoppedSpeakingFrame` for this turn. Pass false when
   * something else in the pipeline has already emitted it.
   */
  enableUserSpeakingFrames?: boolean | null;
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
 *   - `on_broadcast_frame`: Indicates the strategy wants to broadcast a frame.
 *   - `on_user_turn_stopped`: Reports the strategy's decision that the user
 *     is done, from `reportUserTurnStopped()`. The turn controller combines
 *     the stop strategies' decisions into the turn end.
 *   - `on_user_turn_inference_triggered`: Starts a speculative inference for
 *     a turn that hasn't ended yet, carrying a `UserTurnSpeculation`, from
 *     `startUserTurnSpeculation()`.
 *   - `on_user_turn_speculation_cancelled`: Withdraws that speculation, from
 *     `cancelUserTurnSpeculation()`.
 *
 * Porting note: the deprecated `enable_user_speaking_frames` constructor
 * argument, the deprecated `reset()` hook, the deprecated `trigger_*` methods
 * (`trigger_user_turn_stopped`, `trigger_user_turn_finalized`,
 * `trigger_user_turn_inference_triggered`,
 * `trigger_user_turn_speculation_cancelled`, and the override compatibility
 * for them) and the deprecated `ProcessFrameResult` return value are not
 * ported.
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
   * Whether this strategy waits for the turn's inference before deciding.
   *
   * In a `StrategyMode.ALL` list, the turn's inference runs once every other
   * stop strategy has decided, and this strategy then decides on it.
   * Override to true in a strategy that decides from the turn's answer, such
   * as one reading the LLM's turn-completion marker.
   */
  get waitsForInference(): boolean {
    return false;
  }

  /**
   * Whether this strategy has a decision of its own scheduled.
   *
   * While a stop strategy has one, the turn controller's stop timeout waits
   * for it instead of ending the turn. Override to return true only while the
   * strategy is sure to decide soon on its own, as when a timer of its own
   * will fire, so a turn whose decision never comes still times out.
   */
  get decisionScheduled(): boolean {
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
   */
  async processFrame(_frame: Frame): Promise<void> {}

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
  async cancelUserTurnSpeculation(): Promise<void> {
    await this._callEventHandler("on_user_turn_speculation_cancelled");
  }

  /**
   * Report that the user is done, by firing `on_user_turn_stopped`.
   *
   * A strategy calls this when it decides the user's turn has ended. The
   * controller combines the stop strategies' decisions into the turn end, and
   * runs the turn's inference itself once they have decided.
   */
  async reportUserTurnStopped(options: ReportUserTurnStoppedOptions = {}): Promise<void> {
    await this._callEventHandler(
      "on_user_turn_stopped",
      new UserTurnStoppedParams({
        enableUserSpeakingFrames:
          options.enableUserSpeakingFrames ?? this._enableUserSpeakingFrames,
        confirmsSpeculation: options.confirmsSpeculation ?? false,
      }),
    );
  }

  /**
   * Start a speculative inference, by firing `on_user_turn_inference_triggered`.
   *
   * The controller runs a turn's inference itself once the stop strategies
   * have decided, so a strategy only calls this to answer ahead of that, as an
   * eager end of turn does.
   *
   * @param speculation The speculation to run, against a provisional context
   *   carrying the turn text it names, for a turn that hasn't ended yet. The
   *   speculation gate keeps its response back until the turn is confirmed.
   */
  async startUserTurnSpeculation(speculation: UserTurnSpeculation): Promise<void> {
    await this._callEventHandler("on_user_turn_inference_triggered", speculation);
  }
}
