// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_start/wake_phrase_user_turn_start_strategy.py

/** User turn start strategy that gates interaction behind wake phrase detection. */

import { Event, type Task, TimeoutError, waitFor } from "@pipecat-ts/asyncio";
import {
  BotSpeakingFrame,
  type Frame,
  TranscriptionFrame,
  UserSpeakingFrame,
  VADUserStartedSpeakingFrame,
} from "../../frames/frames.ts";
import type { FrameProcessorSetup } from "../../processors/frame_processor.ts";
import { logger } from "../../utils/logger.ts";
import { ProcessFrameResult } from "../types.ts";
import {
  BaseUserTurnStartStrategy,
  type BaseUserTurnStartStrategyOptions,
} from "./base_user_turn_start_strategy.ts";

/** Internal state for wake phrase detection. */
export const _WakeState = {
  IDLE: "idle",
  AWAKE: "awake",
} as const;
export type _WakeState = (typeof _WakeState)[keyof typeof _WakeState];

// Python's `\w` is Unicode-aware; JS's is ASCII-only even with the `u` flag.
const WORD_CHAR = "[\\p{L}\\p{N}\\p{M}_]";
const NON_WORD_NON_SPACE = /[^\p{L}\p{N}\p{M}_\s]/gu;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

export interface WakePhraseUserTurnStartStrategyOptions extends BaseUserTurnStartStrategyOptions {
  /** List of wake phrases to detect. */
  phrases: string[];
  /**
   * Inactivity timeout in seconds before returning to IDLE. In timeout mode,
   * the timer resets on activity. In single activation mode, acts as a
   * keepalive window after wake phrase detection.
   */
  timeout?: number;
  /**
   * If true, the wake phrase is required before every turn. The strategy
   * returns to IDLE after each turn completes.
   */
  singleActivation?: boolean;
}

/**
 * User turn start strategy that requires a wake phrase before interaction.
 *
 * Blocks subsequent strategies until a wake phrase is detected in a final
 * transcription. After detection, allows interaction for a configurable
 * timeout period before requiring the wake phrase again. Use
 * `singleActivation: true` to require the wake phrase before every turn.
 *
 * This strategy should be placed first in the start strategies list.
 *
 * Event handlers available:
 *
 * - on_wake_phrase_detected: Called when a wake phrase is matched.
 * - on_wake_phrase_timeout: Called when the inactivity timeout expires
 *   (timeout mode only).
 *
 * @example
 * // Timeout mode (default): wake phrase unlocks interaction for 10s
 * const strategy = new WakePhraseUserTurnStartStrategy({
 *   phrases: ["hey pipecat", "ok pipecat"],
 *   timeout: 10.0,
 * });
 *
 * // Single activation: wake phrase required before every turn
 * const single = new WakePhraseUserTurnStartStrategy({
 *   phrases: ["hey pipecat"],
 *   singleActivation: true,
 * });
 *
 * strategy.eventHandler("on_wake_phrase_detected", async (strategy, phrase) => { ... });
 * strategy.eventHandler("on_wake_phrase_timeout", async (strategy) => { ... });
 *
 * `timeout`: In timeout mode, the timer resets on activity (user, bot speech).
 * In single activation mode, acts as a keepalive window — the strategy stays
 * AWAKE for this duration after wake phrase detection, allowing the current
 * turn to complete before returning to IDLE.
 */
export class WakePhraseUserTurnStartStrategy extends BaseUserTurnStartStrategy {
  protected _phrases: string[];
  protected _timeout: number;
  protected _singleActivation: boolean;
  protected _patterns: RegExp[] = [];
  protected _state: _WakeState = _WakeState.IDLE;
  protected _accumulatedText = "";
  protected _timeoutEvent = new Event();
  protected _timeoutTask: Task<unknown> | null = null;

  constructor(options: WakePhraseUserTurnStartStrategyOptions) {
    super(options);
    this._phrases = options.phrases;
    this._timeout = options.timeout ?? 10.0;
    this._singleActivation = options.singleActivation ?? false;

    for (const phrase of this._phrases) {
      const words = phrase.split(/\s+/).filter((word) => word.length > 0);
      const pattern = new RegExp(
        `(?<!${WORD_CHAR})${words.map(escapeRegExp).join("\\s*")}(?!${WORD_CHAR})`,
        "iu",
      );
      this._patterns.push(pattern);
    }

    this._registerEventHandler("on_wake_phrase_detected");
    this._registerEventHandler("on_wake_phrase_timeout");
  }

  /** Returns the current wake state. */
  get state(): _WakeState {
    return this._state;
  }

  /**
   * Set up the strategy.
   *
   * @param setup Configuration object containing setup parameters.
   */
  override async setup(setup: FrameProcessorSetup): Promise<void> {
    await super.setup(setup);
    if (!this._timeoutTask) {
      this._timeoutTask = this.taskManager.createTask(
        () => this._timeoutTaskHandler(),
        `${this}::_timeout_task_handler`,
      );
    }
  }

  /** Cleanup the strategy. */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this._timeoutTask) {
      await this.taskManager.cancelTask(this._timeoutTask);
      this._timeoutTask = null;
    }
  }

  /**
   * Ready the strategy for a new user turn.
   *
   * In timeout mode, preserves state and refreshes the timeout — a turn
   * starting is the activity that keeps the strategy awake. In single
   * activation mode, does nothing: the keepalive timeout (started when the
   * wake phrase was detected) handles the transition back to IDLE.
   */
  override async handleUserTurnStarted(): Promise<void> {
    if (this._state === _WakeState.AWAKE) {
      if (!this._singleActivation) {
        this._refreshTimeout();
      }
    }
  }

  /**
   * Process an incoming frame for wake phrase detection or passthrough.
   *
   * @param frame The frame to be processed.
   * @returns STOP when the wake phrase is detected or when in IDLE state
   *   (blocks subsequent strategies), CONTINUE when in AWAKE state (allows
   *   subsequent strategies to proceed).
   */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    await super.processFrame(frame);

    if (this._state === _WakeState.IDLE) {
      return await this._processIdle(frame);
    }
    return await this._processAwake(frame);
  }

  /**
   * Process a frame while in IDLE state.
   *
   * Only final `TranscriptionFrame` instances are checked for wake phrase
   * matches. When a match is found, a user turn start is triggered.
   * Transcription frames that don't match have their text cleared so that
   * pre-wake-phrase speech is not added to the LLM context. All frames
   * return STOP to block subsequent strategies.
   */
  protected async _processIdle(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof TranscriptionFrame) {
      if (this._checkWakePhrase(frame.text)) {
        await this.triggerUserTurnStarted();
        return ProcessFrameResult.STOP;
      }
      await this.triggerResetAggregation();
    }

    return ProcessFrameResult.STOP;
  }

  /**
   * Process a frame while in AWAKE state.
   *
   * Refreshes the timeout on activity frames (timeout mode only). Returns
   * CONTINUE so subsequent strategies can process the frame.
   */
  protected async _processAwake(frame: Frame): Promise<ProcessFrameResult> {
    if (!this._singleActivation) {
      if (frame instanceof UserSpeakingFrame || frame instanceof BotSpeakingFrame) {
        this._refreshTimeout();
      } else if (frame instanceof TranscriptionFrame) {
        this._refreshTimeout();
      } else if (frame instanceof VADUserStartedSpeakingFrame) {
        this._refreshTimeout();
      }
    }

    return ProcessFrameResult.CONTINUE;
  }

  /** Strip punctuation from text, keeping only letters, digits, and whitespace. */
  protected static _stripPunctuation(text: string): string {
    return text.replace(NON_WORD_NON_SPACE, "");
  }

  /**
   * Check if the accumulated text contains a wake phrase.
   *
   * Punctuation is stripped before matching so that STT output like
   * "Hey, Pipecat!" still matches the phrase "hey pipecat".
   *
   * @param text New transcription text to append and check.
   * @returns True if a wake phrase was found, false otherwise.
   */
  protected _checkWakePhrase(text: string): boolean {
    this._accumulatedText += ` ${WakePhraseUserTurnStartStrategy._stripPunctuation(text)}`;
    // Cap accumulated text to prevent unbounded growth.
    if (this._accumulatedText.length > 250) {
      this._accumulatedText = this._accumulatedText.slice(-250);
    }

    for (const [i, pattern] of this._patterns.entries()) {
      if (pattern.test(this._accumulatedText)) {
        const phrase = this._phrases[i] as string;
        logger.debug(`${this} wake phrase detected: '${phrase}'`);
        this._transitionToAwake(phrase);
        return true;
      }
    }

    return false;
  }

  /** Transition from IDLE to AWAKE state. */
  protected _transitionToAwake(phrase: string): void {
    this._state = _WakeState.AWAKE;
    this._accumulatedText = "";
    this._refreshTimeout();
    this.taskManager.createTask(
      () => this._callEventHandler("on_wake_phrase_detected", phrase),
      `${this}::on_wake_phrase_detected`,
    );
  }

  /** Transition from AWAKE to IDLE state. */
  protected _transitionToIdle(): void {
    logger.debug(`${this} wake phrase timeout, returning to IDLE`);
    this._state = _WakeState.IDLE;
    this._accumulatedText = "";
    this.taskManager.createTask(
      () => this._callEventHandler("on_wake_phrase_timeout"),
      `${this}::on_wake_phrase_timeout`,
    );
  }

  /** Refresh the inactivity timeout. */
  protected _refreshTimeout(): void {
    this._timeoutEvent.set();
  }

  /** Background task that monitors inactivity timeout. */
  protected async _timeoutTaskHandler(): Promise<void> {
    while (true) {
      try {
        await waitFor(() => this._timeoutEvent.wait(), this._timeout);
        this._timeoutEvent.clear();
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        if (this._state === _WakeState.AWAKE) {
          this._transitionToIdle();
        }
      }
    }
  }
}
