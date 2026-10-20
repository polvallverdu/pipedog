// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_idle_controller.py

/** This module defines a controller for managing user idle detection. */

import { sleep, type Task } from "@pipedog/asyncio";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
  UserIdleTimeoutUpdateFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../frames/frames.ts";
import type { FrameProcessorSetup } from "../processors/frame_processor.ts";
import { BaseObject } from "../utils/base_object.ts";

export interface UserIdleControllerOptions {
  /**
   * Timeout in seconds before considering the user idle. 0 disables idle
   * detection.
   */
  userIdleTimeout?: number;
}

/**
 * Controller for managing user idle detection.
 *
 * This class monitors user activity and triggers an event when the user has
 * been idle (not speaking) for a configured timeout period after the bot
 * finishes speaking. The timer starts when BotStoppedSpeakingFrame is received
 * and is cancelled when someone starts speaking again
 * (UserStartedSpeakingFrame or BotStartedSpeakingFrame).
 *
 * The timer is suppressed while a user turn is in progress to avoid false
 * triggers during interruptions (where BotStoppedSpeakingFrame arrives while
 * the user is still speaking).
 *
 * A UserIdleTimeoutUpdateFrame applies immediately: it restarts a running
 * timer with the new duration and, while waiting for the user to speak, arms
 * the timer even if idle detection was previously disabled.
 *
 * Event handlers available:
 *
 * - on_user_turn_idle: Emitted when the user has been idle for the timeout period.
 *
 * @example
 * controller.eventHandler("on_user_turn_idle", async (controller) => {
 *   // Handle user idle - send reminder, prompt, etc.
 * });
 */
export class UserIdleController extends BaseObject {
  protected _userIdleTimeout: number;

  protected _waitingForUser = false;
  protected _botSpeaking = false;
  protected _userTurnInProgress = false;
  protected _functionCallsInProgress = 0;
  protected _idleTimerTask: Task<unknown> | null = null;

  constructor(options: UserIdleControllerOptions = {}) {
    super();

    this._userIdleTimeout = options.userIdleTimeout ?? 0;

    this._registerEventHandler("on_user_turn_idle", true);
  }

  /**
   * Whether the bot has finished responding and is waiting for the user.
   *
   * False while the bot is thinking, speaking or running a function call,
   * and during a user turn.
   */
  get waitingForUser(): boolean {
    return this._waitingForUser;
  }

  /** Whether function calls have started and not finished. */
  get functionCallsInProgress(): boolean {
    return this._functionCallsInProgress > 0;
  }

  /**
   * Set up the controller.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup.taskManager);
  }

  /**
   * Stop the idle timer.
   *
   * Called at session end so it can't report idleness that only means the
   * session is over.
   */
  async stop(): Promise<void> {
    await this._cancelIdleTimer();
  }

  /** Cleanup the controller. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    await this.stop();
  }

  /**
   * Process an incoming frame to track user activity state.
   *
   * @param frame The frame to be processed.
   */
  async processFrame(frame: Frame): Promise<void> {
    if (frame instanceof UserIdleTimeoutUpdateFrame) {
      this._userIdleTimeout = frame.timeout;
      if (this._userIdleTimeout <= 0) {
        await this._cancelIdleTimer();
      } else if (this._waitingForUser) {
        // Apply the new timeout now: restart a running timer with the new
        // duration, or arm one if idle detection was previously disabled.
        await this._startIdleTimer();
      }
      return;
    }

    if (frame instanceof BotStoppedSpeakingFrame) {
      this._botSpeaking = false;
      // Only start the timer if the user isn't mid-turn and no function
      // calls are pending.
      //
      // Interruption case: the frame order is UserStartedSpeaking →
      // BotStoppedSpeaking → (user keeps talking) → UserStoppedSpeaking.
      // Without the user-turn guard the timer would start while the user is
      // still speaking.
      //
      // Function call case: normally FunctionCallsStarted arrives after
      // BotStoppedSpeaking and cancels the timer directly. But a race
      // condition can cause FunctionCallsStarted to arrive before
      // BotStoppedSpeaking when pushing a TTSSpeakFrame in the
      // on_function_calls_started event handler, so the counter guard
      // prevents the timer from starting while a function call is in
      // progress.
      if (!this._userTurnInProgress && this._functionCallsInProgress === 0) {
        // Track the waiting-for-user window even when the timeout is
        // currently <= 0 (no timer), so a later timeout update can arm the
        // timer without waiting for the next bot turn.
        this._waitingForUser = true;
        await this._startIdleTimer();
      }
    } else if (frame instanceof BotStartedSpeakingFrame) {
      this._botSpeaking = true;
      this._waitingForUser = false;
      await this._cancelIdleTimer();
    } else if (frame instanceof UserStartedSpeakingFrame) {
      this._waitingForUser = false;
      this._userTurnInProgress = true;
      await this._cancelIdleTimer();
    } else if (frame instanceof UserStoppedSpeakingFrame) {
      this._userTurnInProgress = false;
    } else if (frame instanceof FunctionCallsStartedFrame) {
      this._waitingForUser = false;
      this._functionCallsInProgress += frame.functionCalls.length;
      await this._cancelIdleTimer();
    } else if (
      frame instanceof FunctionCallResultFrame ||
      frame instanceof FunctionCallCancelFrame
    ) {
      this._functionCallsInProgress = Math.max(0, this._functionCallsInProgress - 1);
    }
  }

  /**
   * Start waiting for the user after a turn the bot will not answer.
   *
   * The timer normally starts when the bot stops speaking. A user turn that
   * ends with nothing for the bot to answer (e.g. no transcript) cancels the
   * timer without the bot speaking again afterwards, so the caller re-arms it
   * here. Does nothing while the bot is speaking, a user turn is in progress,
   * or function calls are pending.
   */
  async waitForUser(): Promise<void> {
    if (this._botSpeaking || this._userTurnInProgress) return;
    if (this._functionCallsInProgress > 0) return;
    this._waitingForUser = true;
    await this._startIdleTimer();
  }

  /** Start (or restart) the idle timer. */
  protected async _startIdleTimer(): Promise<void> {
    if (this._userIdleTimeout <= 0) return;
    await this._cancelIdleTimer();
    this._idleTimerTask = this.createTask(() => this._idleTimerExpired(), "_idleTimerExpired");
  }

  /** Cancel the idle timer if running. */
  protected async _cancelIdleTimer(): Promise<void> {
    if (this._idleTimerTask) {
      await this.cancelTask(this._idleTimerTask);
      this._idleTimerTask = null;
    }
  }

  /** Sleep for the timeout duration then fire the idle event. */
  protected async _idleTimerExpired(): Promise<void> {
    await sleep(this._userIdleTimeout);
    this._idleTimerTask = null;
    await this._callEventHandler("on_user_turn_idle");
  }
}
