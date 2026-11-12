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
  UserTurnResponseCancelFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "../frames/frames.ts";
import { FrameDirection, type FrameProcessorSetup } from "../processors/frame_processor.ts";
import { BaseObject } from "../utils/base_object.ts";
import { logger } from "../utils/logger.ts";
import { UserTurnResumedParams, type UserTurnSpeculation } from "./types.ts";
import { type BaseUserTurnStartStrategy, UserTurnStartedParams } from "./user_start/index.ts";
import { type BaseUserTurnStopStrategy, UserTurnStoppedParams } from "./user_stop/index.ts";
import {
  StrategyMode,
  type UserTurnStrategies,
  UserTurnStrategiesParams,
} from "./user_turn_strategies.ts";

/** The inference triggered for the stop decisions made so far in a user turn. */
const _UserTurnInference = {
  NONE: "none",
  TRIGGERED: "triggered",
  SPECULATIVE: "speculative",
} as const;
type _UserTurnInference = (typeof _UserTurnInference)[keyof typeof _UserTurnInference];

export interface UserTurnControllerOptions {
  /** Configured strategies for starting and stopping user turns. */
  userTurnStrategies: UserTurnStrategies;
  /** How the strategies decide. Defaults to `new UserTurnStrategiesParams()`. */
  userTurnStrategiesParams?: UserTurnStrategiesParams | null;
  /**
   * Seconds without user activity before an open user turn is ended, unless a
   * stop strategy has a decision scheduled.
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
 * How a turn starts and ends follows the `startMode` and `stopMode` of its
 * `UserTurnStrategiesParams`. With `StrategyMode.FIRST` the first strategy to
 * decide starts or ends the turn. With `StrategyMode.ALL` the turn starts or
 * ends once every strategy in the list has decided. Turns start on the first
 * start strategy and end once every stop strategy agrees by default. A stop
 * strategy that waits for the turn's inference gets its say in either mode:
 * in a `FIRST` list, the first stop strategy to decide runs the inference,
 * and the turn ends once a strategy waiting for that inference decides. A
 * cancelled answer voids the stop decisions made on it.
 *
 * In an `ALL` list the controller starts the turn's inference itself, once
 * every stop strategy that listens to the user has decided. A stop strategy
 * that waits for the inference instead, such as one reading the LLM's
 * turn-completion marker, then decides on that inference. An eager end of
 * turn still starts its speculation at once.
 *
 * Event handlers available:
 *
 * - on_user_turn_started: Emitted when a user turn starts.
 * - on_user_turn_inference_triggered: Emitted when enough signal exists to
 *   start LLM inference, carrying a `UserTurnSpeculation` when the turn it
 *   answers hasn't ended yet. Fires together with `on_user_turn_stopped` for
 *   most strategies; fires alone when the turn's end waits for a decision on
 *   the inference, or for an eager end of turn to be confirmed.
 * - on_user_turn_stopped: Emitted when a user turn is semantically final.
 * - on_user_turn_resumed: Emitted when the user starts speaking again in an
 *   open turn, after they stopped or after the turn's inference was
 *   triggered. Its `UserTurnResumedParams` say whether that inference was
 *   triggered, since the new speech voids the answer it started.
 * - on_user_turn_stop_timeout: Emitted when the stop timeout ends a user turn
 *   its stop strategies didn't end.
 * - on_user_turn_speculation_cancelled: Emitted when a stop strategy
 *   withdraws its speculative inference, such as an eager end of turn whose
 *   prediction turned out wrong.
 * - on_reset_aggregation: Emitted when a start strategy wants the user's
 *   aggregated text dropped, as the wake phrase strategy does for speech
 *   before the wake phrase.
 * - on_push_frame: Emitted when a strategy wants to push a frame.
 * - on_broadcast_frame: Emitted when a strategy wants to broadcast a frame.
 *
 * Porting note: upstream still unwraps the deprecated
 * `DeferredUserTurnStopStrategy` and honors the deprecated
 * `ProcessFrameResult.STOP` in a `StrategyMode.FIRST` list; neither is ported.
 *
 * @example
 * controller.eventHandler("on_user_turn_started", async (controller, strategy, params) => { ... });
 * controller.eventHandler(
 *   "on_user_turn_inference_triggered",
 *   async (controller, strategy, speculation) => { ... },
 * );
 * controller.eventHandler("on_user_turn_stopped", async (controller, strategy, params) => { ... });
 * controller.eventHandler("on_user_turn_resumed", async (controller, params) => { ... });
 * controller.eventHandler("on_user_turn_stop_timeout", async (controller) => { ... });
 * controller.eventHandler("on_user_turn_speculation_cancelled", async (controller) => { ... });
 * controller.eventHandler("on_reset_aggregation", async (controller, strategy) => { ... });
 * controller.eventHandler("on_push_frame", async (controller, frame, direction) => { ... });
 * controller.eventHandler("on_broadcast_frame", async (controller, frameCls, options) => { ... });
 */
export class UserTurnController extends BaseObject {
  protected _userTurnStrategies: UserTurnStrategies;
  protected _userTurnStopStrategies: BaseUserTurnStopStrategy[];
  protected _userTurnStrategiesParams: UserTurnStrategiesParams;
  protected _userTurnStopTimeout: number;
  protected _setup: FrameProcessorSetup | null = null;

  protected _userSpeaking = false;

  protected _userTurn = false;
  protected _userTurnStartDecisions = new Map<BaseUserTurnStartStrategy, UserTurnStartedParams>();
  protected _userTurnStopDecisions = new Map<BaseUserTurnStopStrategy, UserTurnStoppedParams>();
  // The inference triggered for the stop decisions made so far, if any.
  protected _userTurnInference: _UserTurnInference = _UserTurnInference.NONE;
  // Whether the open turn interrupts the bot, as its start decided.
  protected _userTurnEnableInterruptions = false;
  protected _userTurnStopTimeoutEvent = new Event();
  protected _userTurnStopTimeoutTask: Task<unknown> | null = null;

  constructor(options: UserTurnControllerOptions) {
    super();

    this._userTurnStrategies = options.userTurnStrategies;
    this._userTurnStopStrategies = UserTurnController._stopStrategiesOf(options.userTurnStrategies);
    this._userTurnStrategiesParams =
      options.userTurnStrategiesParams ?? new UserTurnStrategiesParams();
    this._userTurnStopTimeout = options.userTurnStopTimeout ?? 5.0;

    this._registerEventHandler("on_push_frame", true);
    this._registerEventHandler("on_broadcast_frame", true);
    this._registerEventHandler("on_user_turn_started", true);
    this._registerEventHandler("on_user_turn_inference_triggered", true);
    this._registerEventHandler("on_user_turn_speculation_cancelled", true);
    this._registerEventHandler("on_user_turn_stopped", true);
    this._registerEventHandler("on_user_turn_resumed", true);
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
    this._userTurnStopStrategies = UserTurnController._stopStrategiesOf(strategies);
    this._userTurnStartDecisions.clear();
    this._userTurnStopDecisions.clear();
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
    return this._userTurnStopStrategies.some((s) => s.resolvesProposedTurnStopFrames);
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

    // Every strategy sees every frame.
    for (const strategy of this._userTurnStrategies.start ?? []) {
      await strategy.processFrame(frame);
    }

    for (const strategy of this._userTurnStopStrategies) {
      await strategy.processFrame(frame);
    }

    // Handled once the stop strategies have seen it, so an inference started
    // here is the one they then wait for.
    if (frame instanceof UserTurnResponseCancelFrame) {
      await this._handleUserTurnResponseCancel();
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

    for (const s of this._userTurnStopStrategies) {
      await s.setup(this._setup);
      s.addEventHandler("on_push_frame", this._onPushFrame);
      s.addEventHandler("on_broadcast_frame", this._onBroadcastFrame);
      s.addEventHandler("on_user_turn_inference_triggered", this._onUserTurnInferenceTriggered);
      s.addEventHandler("on_user_turn_speculation_cancelled", this._onUserTurnSpeculationCancelled);
      s.addEventHandler("on_user_turn_stopped", this._onUserTurnStopped);
    }

    this._warnIfNoStopStrategyListensToTheUser();
  }

  protected _warnIfNoStopStrategyListensToTheUser(): void {
    // The turn's inference runs once the stop strategies that listen to the
    // user have decided, so with none of them only the stop timeout runs it.
    const stopStrategies = this._userTurnStopStrategies;
    if (stopStrategies.length > 0 && stopStrategies.every((s) => s.waitsForInference)) {
      logger.warning(
        `${this}: every user turn stop strategy waits for the turn's inference, so ` +
          "nothing runs it until the user turn stop timeout. Add a stop strategy that " +
          "detects the user stopping, such as SpeechTimeoutUserTurnStopStrategy.",
      );
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

    for (const s of this._userTurnStopStrategies) {
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
    await this._handleSpeechStarted();

    // The user started talking, let's reset the user turn timeout.
    this._userTurnStopTimeoutEvent.set();
  }

  protected async _handleUserStoppedSpeaking(
    _frame: UserStoppedSpeakingFrame | ProposedUserStoppedSpeakingFrame,
  ): Promise<void> {
    this._userSpeaking = false;

    // The user stopped talking, let's reset the user turn timeout.
    this._userTurnStopTimeoutEvent.set();

    await this._endUserTurnIfDecided();
  }

  protected async _handleVadUserStartedSpeaking(
    _frame: VADUserStartedSpeakingFrame,
  ): Promise<void> {
    await this._handleSpeechStarted();

    // The user started talking, let's reset the user turn timeout.
    this._userTurnStopTimeoutEvent.set();
  }

  protected async _handleVadUserStoppedSpeaking(
    _frame: VADUserStoppedSpeakingFrame,
  ): Promise<void> {
    this._userSpeaking = false;

    // The user stopped talking, let's reset the user turn timeout.
    this._userTurnStopTimeoutEvent.set();

    await this._endUserTurnIfDecided();
  }

  protected async _handleSpeechStarted(): Promise<void> {
    // Speech in an open turn clears the stop decisions made so far, and the
    // inference triggered for them. It resumes the turn when the user had
    // stopped, or when that inference was already triggered.
    const resumed = this._userTurn && (!this._userSpeaking || this._userTurnInferenceTriggered);
    const params = new UserTurnResumedParams({
      enableInterruptions: this._userTurnEnableInterruptions,
      inferenceTriggered: this._userTurnInferenceTriggered,
    });
    this._userSpeaking = true;
    this._userTurnStopDecisions.clear();
    this._userTurnInference = _UserTurnInference.NONE;
    if (resumed) {
      await this._callEventHandler("on_user_turn_resumed", params);
    }
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

  protected get _startMode(): StrategyMode {
    return this._userTurnStrategiesParams.startMode;
  }

  protected _onUserTurnStarted = async (
    strategy: BaseUserTurnStartStrategy,
    params: UserTurnStartedParams,
  ): Promise<void> => {
    if (this._startMode === StrategyMode.ALL) {
      await this._addUserTurnStartDecision(strategy, params);
    } else {
      await this._triggerUserTurnStart(strategy, params);
    }
  };

  protected _onResetAggregation = async (strategy: BaseUserTurnStartStrategy): Promise<void> => {
    await this._callEventHandler("on_reset_aggregation", strategy);
  };

  protected async _addUserTurnStartDecision(
    strategy: BaseUserTurnStartStrategy,
    params: UserTurnStartedParams,
  ): Promise<void> {
    if (this._userTurn) return;

    this._userTurnStartDecisions.set(strategy, params);

    if (this._userTurnStartDecisions.size === (this._userTurnStrategies.start ?? []).length) {
      await this._triggerUserTurnStart(strategy, this._userTurnStartParams());
    }
  }

  protected _userTurnStartParams(): UserTurnStartedParams {
    // One decision saying the turn shouldn't interrupt, or was announced
    // elsewhere, applies to the whole turn.
    const decisions = [...this._userTurnStartDecisions.values()];
    return new UserTurnStartedParams({
      enableInterruptions: decisions.every((d) => d.enableInterruptions),
      enableUserSpeakingFrames: decisions.every((d) => d.enableUserSpeakingFrames),
    });
  }

  protected async _triggerUserTurnStart(
    strategy: BaseUserTurnStartStrategy | null,
    params: UserTurnStartedParams,
  ): Promise<void> {
    // Prevent two consecutive user turn starts.
    if (this._userTurn) return;

    this._userTurn = true;
    this._userTurnStartDecisions.clear();
    this._userTurnStopTimeoutEvent.set();
    this._userTurnEnableInterruptions = params.enableInterruptions;

    // Notify every strategy that the turn has started. Start strategies ready
    // themselves for the next detection; stop strategies arm to detect this
    // turn's end. A strategy resets whatever per-turn state it keeps inside
    // its own handleUserTurnStarted.
    for (const s of this._userTurnStrategies.start ?? []) {
      await s.handleUserTurnStarted();
    }
    for (const s of this._userTurnStopStrategies) {
      await s.handleUserTurnStarted();
    }

    await this._callEventHandler("on_user_turn_started", strategy, params);
  }

  protected get _stopMode(): StrategyMode {
    return this._userTurnStrategiesParams.stopMode;
  }

  protected get _userTurnInferenceTriggered(): boolean {
    return this._userTurnInference !== _UserTurnInference.NONE;
  }

  protected static _stopStrategiesOf(strategies: UserTurnStrategies): BaseUserTurnStopStrategy[] {
    return [...(strategies.stop ?? [])];
  }

  protected _onUserTurnInferenceTriggered = async (
    strategy: BaseUserTurnStopStrategy,
    speculation: UserTurnSpeculation | null,
  ): Promise<void> => {
    // The controller runs the turn's inference itself once the stop
    // strategies have decided. A strategy only starts one to speculate.
    if (!speculation) return;

    await this._triggerUserTurnInferenceTriggered(strategy, speculation);
  };

  protected _onUserTurnSpeculationCancelled = async (
    _strategy: BaseUserTurnStopStrategy,
  ): Promise<void> => {
    await this._callEventHandler("on_user_turn_speculation_cancelled");
    // Every strategy learns the speculation is gone, as when its service
    // withdraws it.
    await this.processFrame(new UserTurnResponseCancelFrame());
  };

  protected _onUserTurnStopped = async (
    strategy: BaseUserTurnStopStrategy,
    params: UserTurnStoppedParams,
  ): Promise<void> => {
    if (this._stopMode === StrategyMode.ALL) {
      await this._addUserTurnStopDecision(strategy, params);
    } else {
      await this._firstUserTurnStop(strategy, params);
    }
  };

  protected async _handleUserTurnResponseCancel(): Promise<void> {
    // Decisions from strategies that wait for the inference were made on the
    // cancelled answer, so they no longer hold. The other decisions still say
    // the user is done, including one that confirmed the answer, so once
    // they're all in, the turn's answer runs again.
    this._userTurnInference = _UserTurnInference.NONE;
    const kept = new Map<BaseUserTurnStopStrategy, UserTurnStoppedParams>();
    for (const [strategy, params] of this._userTurnStopDecisions) {
      if (!strategy.waitsForInference) {
        kept.set(
          strategy,
          new UserTurnStoppedParams({
            enableUserSpeakingFrames: params.enableUserSpeakingFrames,
            confirmsSpeculation: false,
          }),
        );
      }
    }
    this._userTurnStopDecisions = kept;
    if (this._userTurnStopDecisions.size > 0 && this._readyForInference()) {
      const first = this._userTurnStopDecisions.keys().next().value as BaseUserTurnStopStrategy;
      await this._triggerUserTurnInferenceTriggered(first);
    }
  }

  protected async _triggerUserTurnInferenceTriggered(
    strategy: BaseUserTurnStopStrategy | null,
    speculation: UserTurnSpeculation | null = null,
  ): Promise<void> {
    // Inference-triggered fires only while a turn is active. The turn remains
    // active afterward — only `on_user_turn_stopped` flips state.
    if (!this._userTurn) return;

    this._userTurnInference = speculation
      ? _UserTurnInference.SPECULATIVE
      : _UserTurnInference.TRIGGERED;

    // Re-arm the stop watchdog so a stuck turn (inference fired but
    // finalization never arrives) still times out and finalizes.
    this._userTurnStopTimeoutEvent.set();

    await this._callEventHandler("on_user_turn_inference_triggered", strategy, speculation);
  }

  protected async _firstUserTurnStop(
    strategy: BaseUserTurnStopStrategy,
    params: UserTurnStoppedParams,
  ): Promise<void> {
    if (!this._userTurn) return;

    // The first decision runs the turn's inference and ends the turn. A stop
    // strategy that waits for that inference still gets its say: the turn
    // then ends on its decision instead, keeping what the earlier decisions
    // said about the turn end.
    this._userTurnStopDecisions.set(strategy, params);
    if (!strategy.waitsForInference && !this._userTurnInferenceTriggered) {
      await this._triggerUserTurnInferenceTriggered(strategy);
    }
    if (this._userTurnStopDecided()) {
      await this._triggerUserTurnStop(strategy, this._userTurnStopParams());
    }
  }

  protected async _addUserTurnStopDecision(
    strategy: BaseUserTurnStopStrategy,
    params: UserTurnStoppedParams,
  ): Promise<void> {
    // A decision counts while the user speaks, as when a service still hears
    // them while an eager answer runs. Only the turn end waits for them to
    // stop, and new speech clears the decisions.
    if (!this._userTurn) return;

    this._userTurnStopDecisions.set(strategy, params);
    // The eager strategy confirms its speculation when the transcript
    // commits. If the speculation was already withdrawn, for example because
    // the LLM wrote ◐, there's nothing left to confirm, so it's handled like
    // the withdrawal: the decision becomes a plain one and the committed turn
    // gets its own inference.
    if (params.confirmsSpeculation && this._userTurnInference !== _UserTurnInference.SPECULATIVE) {
      await this._handleUserTurnResponseCancel();
    }

    // Once every stop strategy that listens to the user has decided, run the
    // turn's inference. This comes before the turn-end check below, so when
    // this decision also ends the turn, the inference still starts first.
    if (!this._userTurnInferenceTriggered && this._readyForInference()) {
      await this._triggerUserTurnInferenceTriggered(strategy);
    }

    if (this._userTurnStopDecided()) {
      await this._triggerUserTurnStop(strategy, this._userTurnStopParams());
    }
  }

  protected _userTurnStopDecided(): boolean {
    const decided = this._userTurnStopDecisions;
    if (this._stopMode === StrategyMode.ALL) {
      return decided.size === this._userTurnStopStrategies.length;
    }
    // A FIRST list ends the turn on its first decision, or, when a stop
    // strategy waits for the inference, on that strategy's decision.
    const waiting = this._userTurnStopStrategies.filter((s) => s.waitsForInference);
    return waiting.length > 0 ? waiting.some((s) => decided.has(s)) : decided.size > 0;
  }

  protected async _endUserTurnIfDecided(): Promise<void> {
    // Decisions made while the user was speaking end the turn once they stop.
    // New speech clears them, so they're about the speech just heard.
    if (this._userTurnStopDecisions.size > 0 && this._userTurnStopDecided()) {
      const strategy = [...this._userTurnStopDecisions.keys()].at(-1) ?? null;
      await this._triggerUserTurnStop(strategy, this._userTurnStopParams());
    }
  }

  protected _readyForInference(): boolean {
    // Only the stop strategies that wait for the inference are left to decide.
    return this._userTurnStopStrategies.every(
      (s) => s.waitsForInference || this._userTurnStopDecisions.has(s),
    );
  }

  protected _userTurnStopParams(): UserTurnStoppedParams {
    // One decision saying the turn end was announced elsewhere, or that it
    // confirms a speculation, applies to the whole turn.
    const decisions = [...this._userTurnStopDecisions.values()];
    return new UserTurnStoppedParams({
      enableUserSpeakingFrames: decisions.every((d) => d.enableUserSpeakingFrames),
      confirmsSpeculation: decisions.some((d) => d.confirmsSpeculation),
    });
  }

  protected async _triggerUserTurnStop(
    strategy: BaseUserTurnStopStrategy | null,
    params: UserTurnStoppedParams,
  ): Promise<void> {
    // Prevent two consecutive user turn stops.
    if (!this._userTurn) return;

    // Never end the turn while the user is audibly speaking. The decisions
    // stay, and the turn ends once the user stops.
    if (this._userSpeaking) return;

    this._userTurn = false;
    this._userTurnStopDecisions.clear();
    this._userTurnInference = _UserTurnInference.NONE;
    this._userTurnStopTimeoutEvent.set();

    // Notify every strategy that the turn has ended. Stop strategies reset
    // (and, e.g., drop a turn analyzer's buffered speech that must not
    // survive an externally-ended turn). Start strategies get the same
    // callback, but it's a no-op by default: their reset is turn-start
    // semantic, so resetting them here would be wrong.
    for (const s of this._userTurnStrategies.start ?? []) {
      await s.handleUserTurnStopped();
    }
    for (const s of this._userTurnStopStrategies) {
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
        // A stop strategy with a decision of its own scheduled ends the turn
        // when it fires, so the timeout waits for it.
        const decisionScheduled = this._userTurnStopStrategies.some((s) => s.decisionScheduled);
        if (this._userTurn && !this._userSpeaking && !decisionScheduled) {
          await this._callEventHandler("on_user_turn_stop_timeout");
          // The turn ends with what the decisions made so far said about it,
          // so a confirmed speculation isn't answered a second time.
          await this._triggerUserTurnStop(null, this._userTurnStopParams());
        }
      }
    }
  }
}
