// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_start/base_user_turn_start_strategy.py

/** Base turn start strategy for determining when the user starts speaking. */

import type { Frame } from "../../frames/frames.ts";
import { FrameDirection, type FrameProcessorSetup } from "../../processors/frame_processor.ts";
import { BaseObject, type BaseObjectOptions } from "../../utils/base_object.ts";

export interface UserTurnStartedParamsOptions {
  /** Whether the user aggregator should broadcast an interruption for this turn. */
  enableInterruptions: boolean;
  /**
   * Whether to emit `UserStartedSpeakingFrame` for this turn. False when the
   * turn was already announced elsewhere — by a shared `UserTurnProcessor`,
   * or by a service that emits turn frames rather than proposing them.
   */
  enableUserSpeakingFrames: boolean;
}

/**
 * Parameters emitted when a user turn starts.
 *
 * These parameters are passed to the `on_user_turn_started` event and provide
 * contextual information about how the user turn should be handled by the user
 * aggregator.
 *
 * - `enableUserSpeakingFrames`: Whether to emit `UserStartedSpeakingFrame` for
 *   this turn. False when the turn was already announced elsewhere — by a
 *   shared `UserTurnProcessor`, or by a service that emits turn frames rather
 *   than proposing them.
 */
export class UserTurnStartedParams {
  enableInterruptions: boolean;
  enableUserSpeakingFrames: boolean;

  constructor(options: UserTurnStartedParamsOptions) {
    this.enableInterruptions = options.enableInterruptions;
    this.enableUserSpeakingFrames = options.enableUserSpeakingFrames;
  }
}

export interface BaseUserTurnStartStrategyOptions extends BaseObjectOptions {
  /**
   * If true, the user aggregator will emit an interruption frame when the user
   * turn starts.
   */
  enableInterruptions?: boolean;
}

export interface ReportUserTurnStartedOptions {
  /**
   * Whether to broadcast an interruption for this turn, overriding the
   * strategy's configured setting. Pass false when something else in the
   * pipeline has already broadcast one.
   */
  enableInterruptions?: boolean | null;
  /**
   * Whether to emit `UserStartedSpeakingFrame` for this turn. Pass false when
   * something else in the pipeline has already emitted it.
   */
  enableUserSpeakingFrames?: boolean | null;
}

/**
 * Base class for strategies that determine when a user starts speaking.
 *
 * Subclasses should implement logic to detect the start of a user's turn.
 * This could be based on voice activity, number of words spoken, or other
 * heuristics.
 *
 * Events triggered by user turn start strategies:
 *
 *   - `on_push_frame`: Indicates the strategy wants to push a frame.
 *   - `on_broadcast_frame`: Indicates the strategy wants to broadcast a frame.
 *   - `on_user_turn_started`: Reports the strategy's decision that the
 *     user started, from `reportUserTurnStarted()`. The turn controller starts
 *     the turn on the first decision, or once every start strategy has
 *     decided in a `StrategyMode.ALL` list.
 *   - `on_reset_aggregation`: Asks the user aggregator to drop the text
 *     aggregated so far, from `triggerResetAggregation()`.
 *
 * Porting note: the deprecated `enable_user_speaking_frames` constructor
 * argument, the deprecated `reset()` hook, the deprecated
 * `trigger_user_turn_started()` (and its override compatibility) and the
 * deprecated `ProcessFrameResult` return value are not ported.
 */
export class BaseUserTurnStartStrategy extends BaseObject {
  protected _enableInterruptions: boolean;
  protected _enableUserSpeakingFrames = true;

  constructor(options: BaseUserTurnStartStrategyOptions = {}) {
    super(options);
    this._enableInterruptions = options.enableInterruptions ?? true;
    this._registerEventHandler("on_push_frame", true);
    this._registerEventHandler("on_broadcast_frame", true);
    this._registerEventHandler("on_user_turn_started", true);
    this._registerEventHandler("on_reset_aggregation", true);
  }

  /**
   * Whether this strategy resolves proposals into turn starts.
   *
   * A `ProposedUserStartedSpeakingFrame` is a request for a decision, so a
   * strategy that acts on one consumes it: the frame stops travelling, and no
   * resolver further along decides the same turn a second time. Override to
   * true in a strategy that handles that frame.
   */
  get resolvesProposedTurnStartFrames(): boolean {
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
   * The controller calls this on every start strategy when a turn begins.
   * Override to run, for example, logic to reset state and prepare for the
   * next detection.
   */
  async handleUserTurnStarted(): Promise<void> {}

  /**
   * Notify the strategy that the user turn has stopped.
   *
   * The controller calls this on every start strategy when a turn ends.
   * Override if the strategy needs to act on turn end (likely uncommon).
   */
  async handleUserTurnStopped(): Promise<void> {}

  /**
   * Process an incoming frame.
   *
   * Subclasses should override this to implement logic that decides whether
   * the user turn has started.
   *
   * @param frame The frame to be processed.
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
   * Report that the user started, by firing `on_user_turn_started`.
   *
   * A strategy calls this when it decides the user's turn has started. The
   * turn controller starts the turn on the first decision, or once every
   * start strategy has decided in a `StrategyMode.ALL` list.
   */
  async reportUserTurnStarted(options: ReportUserTurnStartedOptions = {}): Promise<void> {
    await this._callEventHandler(
      "on_user_turn_started",
      new UserTurnStartedParams({
        enableInterruptions: options.enableInterruptions ?? this._enableInterruptions,
        enableUserSpeakingFrames:
          options.enableUserSpeakingFrames ?? this._enableUserSpeakingFrames,
      }),
    );
  }

  /** Trigger the `on_reset_aggregation` event. */
  async triggerResetAggregation(): Promise<void> {
    await this._callEventHandler("on_reset_aggregation");
  }
}
