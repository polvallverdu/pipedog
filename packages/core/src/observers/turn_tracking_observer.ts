// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/turn_tracking_observer.py

/**
 * Turn tracking observer for conversation flow monitoring.
 *
 * Provides an observer that monitors conversation turns in a pipeline,
 * tracking when turns start and end based on user and bot speech patterns.
 */

import { createTask, sleep, type Task } from "@pipedog/asyncio";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  CancelFrame,
  EndFrame,
  StartFrame,
  UserStartedSpeakingFrame,
} from "../frames/frames.ts";
import { logger } from "../utils/logger.ts";
import { BaseObserver, type BaseObserverOptions, type FramePushed } from "./base_observer.ts";

export interface TurnTrackingObserverOptions extends Omit<BaseObserverOptions, "observeEveryPush"> {
  /**
   * Timeout in seconds after bot stops speaking before automatically ending
   * the turn. Defaults to 2.5.
   */
  turnEndTimeoutSecs?: number;
}

/**
 * Observer that tracks conversation turns in a pipeline.
 *
 * This observer monitors the flow of conversation by tracking when turns
 * start and end based on user and bot speaking patterns. It handles
 * interruptions, timeouts, and maintains turn state throughout the pipeline.
 *
 * Turn tracking logic:
 *
 * - The first turn starts immediately when the pipeline starts (StartFrame)
 * - Subsequent turns start when the user starts speaking
 * - A turn ends when the bot stops speaking and either:
 *   - The user starts speaking again
 *   - A timeout period elapses with no more bot speech
 *
 * Events:
 *
 * - on_turn_started: Triggered when a turn starts, providing the turn number
 * - on_turn_ended: Triggered when a turn ends, providing the turn number, the
 *   turn's duration in seconds, and whether it was interrupted
 */
export class TurnTrackingObserver extends BaseObserver {
  protected _turnCount = 0;
  protected _isTurnActive = false;
  protected _isBotSpeaking = false;
  protected _hasBotSpoken = false;
  protected _turnStartTime = 0;
  protected _turnEndTimeoutSecs: number;
  // Stands in for upstream's `loop.call_later` handle: a task that sleeps for
  // the timeout and then ends the turn.
  protected _endTurnTimer: Task<void> | null = null;

  constructor(options: TurnTrackingObserverOptions = {}) {
    super({ ...options, observeEveryPush: false });
    this._turnEndTimeoutSecs = options.turnEndTimeoutSecs ?? 2.5;

    this._registerEventHandler("on_turn_started");
    this._registerEventHandler("on_turn_ended");
  }

  /**
   * Process frame events for turn tracking.
   *
   * @param data Frame push event data containing the frame and metadata.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    if (data.frame instanceof StartFrame) {
      // Start the first turn immediately when the pipeline starts
      if (this._turnCount === 0) {
        await this._startTurn(data);
      }
    } else if (data.frame instanceof UserStartedSpeakingFrame) {
      await this._handleUserStartedSpeaking(data);
    } else if (data.frame instanceof BotStartedSpeakingFrame) {
      await this._handleBotStartedSpeaking(data);
    }
    // A BotStoppedSpeakingFrame can arrive after a UserStartedSpeakingFrame
    // following an interruption. We only want to end the turn if the bot was
    // previously speaking.
    else if (data.frame instanceof BotStoppedSpeakingFrame && this._isBotSpeaking) {
      await this._handleBotStoppedSpeaking(data);
    } else if (data.frame instanceof EndFrame || data.frame instanceof CancelFrame) {
      await this._handlePipelineEnd(data);
    }
  }

  /**
   * Cancel the pending turn end timer.
   *
   * The pipeline can be torn down before this observer receives its EndFrame
   * or CancelFrame, and the timer's callback holds the pipeline until it fires.
   */
  override async cleanup(): Promise<void> {
    this._cancelTurnEndTimer();
    await super.cleanup();
  }

  /** Schedule turn end with a timeout. */
  protected _scheduleTurnEnd(data: FramePushed): void {
    // Cancel any existing timer
    this._cancelTurnEndTimer();

    // Create a new timer
    const timer: Task<void> = createTask(async () => {
      await sleep(this._turnEndTimeoutSecs);
      // The timer has fired: like a `call_later` handle, cancelling it from
      // now on no longer stops the callback.
      if (this._endTurnTimer === timer) {
        this._endTurnTimer = null;
      }
      await this._endTurnAfterTimeout(data);
    }, "TurnTrackingObserver::_end_turn_after_timeout");
    this._endTurnTimer = timer;
  }

  /** Cancel the turn end timer if it exists. */
  protected _cancelTurnEndTimer(): void {
    if (this._endTurnTimer) {
      this._endTurnTimer.cancel();
      this._endTurnTimer = null;
    }
  }

  /** End turn after timeout has expired. */
  protected async _endTurnAfterTimeout(data: FramePushed): Promise<void> {
    if (this._isTurnActive && !this._isBotSpeaking) {
      logger.trace(`Turn ${this._turnCount} ending due to timeout`);
      await this._endTurn(data, false);
      this._endTurnTimer = null;
    }
  }

  /** Handle user speaking events, including interruptions. */
  protected async _handleUserStartedSpeaking(data: FramePushed): Promise<void> {
    if (this._isBotSpeaking) {
      // Handle interruption - end current turn and start a new one
      this._cancelTurnEndTimer(); // Cancel any pending end turn timer
      await this._endTurn(data, true);
      this._isBotSpeaking = false; // Bot is considered interrupted
      await this._startTurn(data);
    } else if (this._isTurnActive && this._hasBotSpoken) {
      // User started speaking during the turnEndTimeoutSecs period after bot speech
      this._cancelTurnEndTimer(); // Cancel any pending end turn timer
      await this._endTurn(data, false);
      await this._startTurn(data);
    } else if (!this._isTurnActive) {
      // Start a new turn after previous one ended
      await this._startTurn(data);
    } else {
      // User is speaking within the same turn (before bot has responded)
      logger.trace(`User is already speaking in Turn ${this._turnCount}`);
    }
  }

  /** Handle bot speaking events. */
  protected async _handleBotStartedSpeaking(_data: FramePushed): Promise<void> {
    this._isBotSpeaking = true;
    this._hasBotSpoken = true;
    // Cancel any pending turn end timer when bot starts speaking again
    this._cancelTurnEndTimer();
  }

  /** Handle bot stopped speaking events. */
  protected async _handleBotStoppedSpeaking(data: FramePushed): Promise<void> {
    this._isBotSpeaking = false;
    // Schedule turn end with timeout.
    // This is needed to handle cases where the bot's speech ends and then
    // resumes. This can happen with HTTP TTS services or function calls.
    this._scheduleTurnEnd(data);
  }

  /** Handle pipeline end or cancellation by flushing any active turn. */
  protected async _handlePipelineEnd(data: FramePushed): Promise<void> {
    this._cancelTurnEndTimer();
    if (this._isTurnActive) {
      await this._endTurn(data, true);
    }
  }

  /** Start a new turn. */
  protected async _startTurn(data: FramePushed): Promise<void> {
    this._isTurnActive = true;
    this._hasBotSpoken = false;
    this._turnCount += 1;
    this._turnStartTime = data.timestamp;
    logger.trace(`Turn ${this._turnCount} started`);
    await this._callEventHandler("on_turn_started", this._turnCount);
  }

  /** End the current turn. */
  protected async _endTurn(data: FramePushed, wasInterrupted: boolean): Promise<void> {
    if (!this._isTurnActive) {
      return;
    }

    const duration = (data.timestamp - this._turnStartTime) / 1_000_000_000; // Convert to seconds
    this._isTurnActive = false;

    const status = wasInterrupted ? "interrupted" : "completed";
    logger.trace(`Turn ${this._turnCount} ${status} after ${duration.toFixed(2)}s`);
    await this._callEventHandler("on_turn_ended", this._turnCount, duration, wasInterrupted);
  }
}
