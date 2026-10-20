// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_turn_controller.py

/** This module defines a controller for managing user turn lifecycle. */

import { Event, type Task, TimeoutError, waitFor } from "@pipedog/asyncio";
import {
  type Frame,
  InterimTranscriptionFrame,
  ProposedUserStartedSpeakingFrame,
  ProposedUserStoppedSpeakingFrame,
  TranscriptionFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../frames/frames.ts";
import { FrameDirection, type FrameProcessorSetup } from "../processors/frame_processor.ts";
import { BaseObject } from "../utils/base_object.ts";
import { ProcessFrameResult, type UserTurnSpeculation } from "./types.ts";
import type { BaseUserTurnStartStrategy, UserTurnStartedParams } from "./user_start/index.ts";
import { type BaseUserTurnStopStrategy, UserTurnStoppedParams } from "./user_stop/index.ts";
import type { UserTurnStrategies } from "./user_turn_strategies.ts";

export interface UserTurnControllerOptions {
  /** Configured strategies for starting and stopping user turns. */
  userTurnStrategies: UserTurnStrategies;
  /**
   * Timeout in seconds to automatically stop a user turn if no activity is
   * detected.
   */
  userTurnStopTimeout?: number;
}

type AnyStrategy = BaseUserTurnStartStrategy | BaseUserTurnStopStrategy;

/**
 * Controller for managing user turn lifecycle.
 *
 * This class manages user turn state (active/inactive), handles start and
 * stop strategies, and emits events when user turns begin, end, or timeout
 * occurs.
 *
 * Event handlers available:
 *
 * - on_user_turn_started: Emitted when a user turn starts.
 * - on_user_turn_inference_triggered: Emitted when enough signal exists to
 *   start LLM inference, carrying a `UserTurnSpeculation` when the turn it
 *   answers hasn't ended yet. Fires together with `on_user_turn_stopped` for
 *   most strategies; fires alone when a downstream strategy gates
 *   finalization on the LLM's verdict.
 * - on_user_turn_stopped: Emitted when a user turn is semantically final.
 * - on_user_turn_stop_timeout: Emitted if no stop strategy triggers before timeout.
 * - on_push_frame: Emitted when a strategy wants to push a frame.
 * - on_broadcast_frame: Emitted when a strategy wants to broadcast a frame.
 *
 * @example
 * controller.eventHandler("on_user_turn_started", async (controller, strategy, params) => { ... });
 * controller.eventHandler(
 *   "on_user_turn_inference_triggered",
 *   async (controller, strategy, speculation) => { ... },
 * );
 * controller.eventHandler("on_user_turn_stopped", async (controller, strategy, params) => { ... });
 * controller.eventHandler("on_user_turn_stop_timeout", async (controller) => { ... });
 * controller.eventHandler("on_push_frame", async (controller, frame, direction) => { ... });
 * controller.eventHandler("on_broadcast_frame", async (controller, frameCls, options) => { ... });
 */
export class UserTurnController extends BaseObject {
  protected _userTurnStrategies: UserTurnStrategies;
  protected _userTurnStopTimeout: number;
  protected _setup: FrameProcessorSetup | null = null;

  protected _userSpeaking = false;

  protected _userTurn = false;
  protected _userTurnStopTimeoutEvent = new Event();
  protected _userTurnStopTimeoutTask: Task<unknown> | null = null;

  constructor(options: UserTurnControllerOptions) {
    super();

    this._userTurnStrategies = options.userTurnStrategies;
    this._userTurnStopTimeout = options.userTurnStopTimeout ?? 5.0;

    this._registerEventHandler("on_push_frame", true);
    this._registerEventHandler("on_broadcast_frame", true);
    this._registerEventHandler("on_user_turn_started", true);
    this._registerEventHandler("on_user_turn_inference_triggered", true);
    this._registerEventHandler("on_user_turn_speculation_cancelled", true);
    this._registerEventHandler("on_user_turn_stopped", true);
    this._registerEventHandler("on_user_turn_stop_timeout", true);
    this._registerEventHandler("on_reset_aggregation", true);
  }

  /** The currently active user turn strategies. */
  get userTurnStrategies(): UserTurnStrategies {
    return this._userTurnStrategies;
  }

  /**
   * Set up the controller.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup.taskManager);

    // Kept so updateStrategies() can set up new strategies without the caller
    // having to hand us the setup again.
    this._setup = setup;

    await this._setupStrategies();
  }

  /**
   * Start watching for a turn that stops without the user stopping.
   *
   * Paired with `stop()`.
   */
  async start(): Promise<void> {
    if (!this._userTurnStopTimeoutTask) {
      this._userTurnStopTimeoutTask = this.createTask(
        () => this._userTurnStopTimeoutTaskHandler(),
        "_userTurnStopTimeoutTaskHandler",
      );
    }
  }

  /**
   * Stop the turn stop timeout, leaving the strategies alone.
   *
   * Called at session end. The strategies may be shared, so cleaning them up
   * waits for `cleanup()`.
   */
  async stop(): Promise<void> {
    if (this._userTurnStopTimeoutTask) {
      await this.cancelTask(this._userTurnStopTimeoutTask);
      this._userTurnStopTimeoutTask = null;
    }
  }

  /** Cleanup the controller. */
  override async cleanup(): Promise<void> {
    await super.cleanup();

    await this.stop();

    await this._cleanupStrategies();
  }

  /**
   * Replace the current strategies with the given ones.
   *
   * @param strategies The new user turn strategies the controller should use.
   */
  async updateStrategies(strategies: UserTurnStrategies): Promise<void> {
    await this._cleanupStrategies();
    this._userTurnStrategies = strategies;
    await this._setupStrategies();
  }

  /**
   * Whether any active start strategy resolves proposed turn starts.
   *
   * A proposal is resolved once, so a caller holding this controller should
   * stop forwarding `ProposedUserStartedSpeakingFrame` when this is true —
   * passing it along would let a resolver further down the pipeline decide
   * the same turn a second time.
   */
  get resolvesProposedTurnStartFrames(): boolean {
    return (this._userTurnStrategies.start ?? []).some((s) => s.resolvesProposedTurnStartFrames);
  }

  /**
   * Whether any active stop strategy resolves proposed turn stops.
   *
   * The end-of-turn counterpart to `resolvesProposedTurnStartFrames`.
   */
  get resolvesProposedTurnStopFrames(): boolean {
    return (this._userTurnStrategies.stop ?? []).some((s) => s.resolvesProposedTurnStopFrames);
  }

  /**
   * Process an incoming frame to detect user turn start or stop.
   *
   * The frame is passed to the configured user turn strategies, which are
   * responsible for deciding when a user turn starts or stops and emitting
   * the corresponding events.
   *
   * @param frame The frame to be processed.
   */
  async processFrame(frame: Frame): Promise<void> {
    if (
      frame instanceof UserStartedSpeakingFrame ||
      frame instanceof ProposedUserStartedSpeakingFrame
    ) {
      await this._handleUserStartedSpeaking(frame);
    } else if (
      frame instanceof UserStoppedSpeakingFrame ||
      frame instanceof ProposedUserStoppedSpeakingFrame
    ) {
      await this._handleUserStoppedSpeaking(frame);
    } else if (frame instanceof VADUserStartedSpeakingFrame) {
      await this._handleVadUserStartedSpeaking(frame);
    } else if (frame instanceof VADUserStoppedSpeakingFrame) {
      await this._handleVadUserStoppedSpeaking(frame);
    } else if (frame instanceof TranscriptionFrame || frame instanceof InterimTranscriptionFrame) {
      await this._handleTranscription(frame);
    }

    for (const strategy of this._userTurnStrategies.start ?? []) {
      const result = await strategy.processFrame(frame);
      if (result === ProcessFrameResult.STOP) break;
    }

    for (const strategy of this._userTurnStrategies.stop ?? []) {
      const result = await strategy.processFrame(frame);
      if (result === ProcessFrameResult.STOP) break;
    }
  }

  protected async _setupStrategies(): Promise<void> {
    if (!this._setup) {
      throw new Error(`${this} was not properly set up`);
    }

    for (const s of this._userTurnStrategies.start ?? []) {
      await s.setup(this._setup);
      s.addEventHandler("on_push_frame", this._onPushFrame);
      s.addEventHandler("on_broadcast_frame", this._onBroadcastFrame);
      s.addEventHandler("on_user_turn_started", this._onUserTurnStarted);
      s.addEventHandler("on_reset_aggregation", this._onResetAggregation);
    }

    for (const s of this._userTurnStrategies.stop ?? []) {
      await s.setup(this._setup);
      s.addEventHandler("on_push_frame", this._onPushFrame);
      s.addEventHandler("on_broadcast_frame", this._onBroadcastFrame);
      s.addEventHandler("on_user_turn_inference_triggered", this._onUserTurnInferenceTriggered);
      s.addEventHandler("on_user_turn_speculation_cancelled", this._onUserTurnSpeculationCancelled);
      s.addEventHandler("on_user_turn_stopped", this._onUserTurnStopped);
    }
  }

  protected async _cleanupStrategies(): Promise<void> {
    // Remove the handlers _setupStrategies added (symmetric), so re-applying
    // strategies via updateStrategies — possibly reusing the same strategy
    // instances — doesn't accumulate duplicate handler registrations.
    for (const s of this._userTurnStrategies.start ?? []) {
      await s.cleanup();
      s.removeEventHandler("on_push_frame", this._onPushFrame);
      s.removeEventHandler("on_broadcast_frame", this._onBroadcastFrame);
      s.removeEventHandler("on_user_turn_started", this._onUserTurnStarted);
      s.removeEventHandler("on_reset_aggregation", this._onResetAggregation);
    }

    for (const s of this._userTurnStrategies.stop ?? []) {
      await s.cleanup();
      s.removeEventHandler("on_push_frame", this._onPushFrame);
      s.removeEventHandler("on_broadcast_frame", this._onBroadcastFrame);
      s.removeEventHandler("on_user_turn_inference_triggered", this._onUserTurnInferenceTriggered);
      s.removeEventHandler(
        "on_user_turn_speculation_cancelled",
        this._onUserTurnSpeculationCancelled,
      );
      s.removeEventHandler("on_user_turn_stopped", this._onUserTurnStopped);
    }
  }

  protected async _handleUserStartedSpeaking(
    _frame: UserStartedSpeakingFrame | ProposedUserStartedSpeakingFrame,
  ): Promise<void> {
    this._userSpeaking = true;

    // The user started talking, let's reset the user turn timeout.
    this._userTurnStopTimeoutEvent.set();
  }

  protected async _handleUserStoppedSpeaking(
    _frame: UserStoppedSpeakingFrame | ProposedUserStoppedSpeakingFrame,
  ): Promise<void> {
    this._userSpeaking = false;

    // The user stopped talking, let's reset the user turn timeout.
    this._userTurnStopTimeoutEvent.set();
  }

  protected async _handleVadUserStartedSpeaking(
    _frame: VADUserStartedSpeakingFrame,
  ): Promise<void> {
    this._userSpeaking = true;

    // The user started talking, let's reset the user turn timeout.
    this._userTurnStopTimeoutEvent.set();
  }

  protected async _handleVadUserStoppedSpeaking(
    _frame: VADUserStoppedSpeakingFrame,
  ): Promise<void> {
    this._userSpeaking = false;

    // The user stopped talking, let's reset the user turn timeout.
    this._userTurnStopTimeoutEvent.set();
  }

  protected async _handleTranscription(
    _frame: TranscriptionFrame | InterimTranscriptionFrame,
  ): Promise<void> {
    // We have received a transcription, let's reset the user turn timeout.
    this._userTurnStopTimeoutEvent.set();
  }

  // Strategy event handlers are arrow functions so the same reference can be
  // added in _setupStrategies() and removed in _cleanupStrategies().

  protected _onPushFrame = async (
    _strategy: AnyStrategy,
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> => {
    await this._callEventHandler("on_push_frame", frame, direction);
  };

  protected _onBroadcastFrame = async (
    _strategy: AnyStrategy,
    frameCls: new (options: never) => Frame,
    options?: unknown,
  ): Promise<void> => {
    await this._callEventHandler("on_broadcast_frame", frameCls, options);
  };

  protected _onUserTurnSpeculationCancelled = async (
    _strategy: BaseUserTurnStopStrategy,
  ): Promise<void> => {
    await this._callEventHandler("on_user_turn_speculation_cancelled");
  };

  protected _onUserTurnStarted = async (
    strategy: BaseUserTurnStartStrategy,
    params: UserTurnStartedParams,
  ): Promise<void> => {
    await this._triggerUserTurnStart(strategy, params);
  };

  protected _onUserTurnInferenceTriggered = async (
    strategy: BaseUserTurnStopStrategy,
    speculation: UserTurnSpeculation | null,
  ): Promise<void> => {
    await this._triggerUserTurnInferenceTriggered(strategy, speculation);
  };

  protected _onUserTurnStopped = async (
    strategy: BaseUserTurnStopStrategy,
    params: UserTurnStoppedParams,
  ): Promise<void> => {
    await this._triggerUserTurnStop(strategy, params);
  };

  protected _onResetAggregation = async (strategy: BaseUserTurnStartStrategy): Promise<void> => {
    await this._callEventHandler("on_reset_aggregation", strategy);
  };

  protected async _triggerUserTurnStart(
    strategy: BaseUserTurnStartStrategy | null,
    params: UserTurnStartedParams,
  ): Promise<void> {
    // Prevent two consecutive user turn starts.
    if (this._userTurn) return;

    this._userTurn = true;
    this._userTurnStopTimeoutEvent.set();

    // Notify every strategy that the turn has started. Start strategies ready
    // themselves for the next detection; stop strategies arm to detect this
    // turn's end. A strategy resets whatever per-turn state it keeps inside
    // its own handleUserTurnStarted.
    for (const s of this._userTurnStrategies.start ?? []) {
      await s.handleUserTurnStarted();
    }
    for (const s of this._userTurnStrategies.stop ?? []) {
      await s.handleUserTurnStarted();
    }

    await this._callEventHandler("on_user_turn_started", strategy, params);
  }

  protected async _triggerUserTurnInferenceTriggered(
    strategy: BaseUserTurnStopStrategy | null,
    speculation: UserTurnSpeculation | null = null,
  ): Promise<void> {
    // Inference-triggered fires only while a turn is active. The turn remains
    // active afterward — only `on_user_turn_stopped` flips state.
    if (!this._userTurn) return;

    // Re-arm the stop watchdog so a stuck turn (inference fired but
    // finalization never arrives) still times out and finalizes.
    this._userTurnStopTimeoutEvent.set();

    await this._callEventHandler("on_user_turn_inference_triggered", strategy, speculation);
  }

  protected async _triggerUserTurnStop(
    strategy: BaseUserTurnStopStrategy | null,
    params: UserTurnStoppedParams,
  ): Promise<void> {
    // Prevent two consecutive user turn stops.
    if (!this._userTurn) return;

    // Never finalize while the user is audibly speaking. A stop strategy can
    // finalize on a latent signal (e.g. an LLM ● that resolves after the user
    // resumed), which is stale by the time it arrives. Keep the turn open so
    // the next inference re-evaluates; the watchdog still finalizes if the
    // user then falls silent. Detector strategies only finalize once the user
    // has stopped, so this is a no-op for them.
    if (this._userSpeaking) return;

    this._userTurn = false;
    this._userTurnStopTimeoutEvent.set();

    // Notify every strategy that the turn has ended. Stop strategies reset
    // (and, e.g., drop a turn analyzer's buffered speech that must not survive
    // an externally-ended turn). Start strategies get the same callback, but
    // it's a no-op by default: their reset is turn-start semantic, so
    // resetting them here would be wrong.
    for (const s of this._userTurnStrategies.start ?? []) {
      await s.handleUserTurnStopped();
    }
    for (const s of this._userTurnStrategies.stop ?? []) {
      await s.handleUserTurnStopped();
    }

    await this._callEventHandler("on_user_turn_stopped", strategy, params);
  }

  protected async _userTurnStopTimeoutTaskHandler(): Promise<void> {
    while (true) {
      try {
        await waitFor(() => this._userTurnStopTimeoutEvent.wait(), this._userTurnStopTimeout);
        this._userTurnStopTimeoutEvent.clear();
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        if (this._userTurn && !this._userSpeaking) {
          await this._callEventHandler("on_user_turn_stop_timeout");
          await this._triggerUserTurnStop(
            null,
            new UserTurnStoppedParams({ enableUserSpeakingFrames: true }),
          );
        }
      }
    }
  }
}
