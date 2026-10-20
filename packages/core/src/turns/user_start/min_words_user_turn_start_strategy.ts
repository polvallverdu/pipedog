// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_start/min_words_user_turn_start_strategy.py

/** User turn start strategy based on a minimum number of words spoken by the user. */

import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  InterimTranscriptionFrame,
  TranscriptionFrame,
} from "../../frames/frames.ts";
import { logger } from "../../utils/logger.ts";
import { ProcessFrameResult } from "../types.ts";
import {
  BaseUserTurnStartStrategy,
  type BaseUserTurnStartStrategyOptions,
} from "./base_user_turn_start_strategy.ts";

export interface MinWordsUserTurnStartStrategyOptions extends BaseUserTurnStartStrategyOptions {
  /** Minimum number of spoken words required to trigger the start of a user turn. */
  minWords: number;
  /** Whether to consider interim transcription frames for earlier detection. */
  useInterim?: boolean;
}

/**
 * User turn start strategy based on a minimum number of words spoken by the user.
 *
 * This strategy signals the start of a user turn once the user has spoken at
 * least a specified number of words, as determined from transcription frames.
 * Optionally, interim transcriptions can be used for earlier detection.
 */
export class MinWordsUserTurnStartStrategy extends BaseUserTurnStartStrategy {
  protected _minWords: number;
  protected _useInterim: boolean;
  protected _botSpeaking = false;

  constructor(options: MinWordsUserTurnStartStrategyOptions) {
    super(options);
    this._minWords = options.minWords;
    this._useInterim = options.useInterim ?? true;
  }

  /**
   * Ready the strategy for a new user turn.
   *
   * Clears the bot-speaking flag so the next turn's word counting starts
   * from the single-word interruption threshold.
   */
  override async handleUserTurnStarted(): Promise<void> {
    this._botSpeaking = false;
  }

  /**
   * Process an incoming frame to detect the start of a user turn.
   *
   * This method updates internal state based on transcription frames and
   * triggers the user turn once the minimum word count is reached.
   *
   * @param frame The frame to be analyzed.
   * @returns STOP if the minimum word count was reached, CONTINUE otherwise.
   */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof BotStartedSpeakingFrame) {
      await this._handleBotStartedSpeaking(frame);
    } else if (frame instanceof BotStoppedSpeakingFrame) {
      await this._handleBotStoppedSpeaking(frame);
    } else if (frame instanceof TranscriptionFrame) {
      return await this._handleTranscription(frame);
    } else if (frame instanceof InterimTranscriptionFrame && this._useInterim) {
      return await this._handleTranscription(frame);
    }

    return ProcessFrameResult.CONTINUE;
  }

  /**
   * Handle bot started speaking frame.
   *
   * If the bot is speaking we want to interrupt using min words.
   */
  protected async _handleBotStartedSpeaking(_frame: BotStartedSpeakingFrame): Promise<void> {
    this._botSpeaking = true;
  }

  /**
   * Handle bot stopped speaking frame.
   *
   * If the bot is not speaking we want to interrupt if we get a single word.
   */
  protected async _handleBotStoppedSpeaking(_frame: BotStoppedSpeakingFrame): Promise<void> {
    this._botSpeaking = false;
  }

  /**
   * Handle a transcription frame and check word count.
   *
   * @param frame The transcription frame to be processed.
   * @returns STOP if the minimum word count was reached, CONTINUE otherwise.
   */
  protected async _handleTranscription(
    frame: TranscriptionFrame | InterimTranscriptionFrame,
  ): Promise<ProcessFrameResult> {
    const minWords = this._botSpeaking ? this._minWords : 1;

    // Python's str.split(): split on whitespace runs, ignoring leading/trailing.
    const trimmed = frame.text.trim();
    const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
    const shouldTrigger = wordCount >= minWords;
    const isInterim = frame instanceof InterimTranscriptionFrame;

    logger.debug(
      `${this} should_trigger=${pyBool(shouldTrigger)} num_spoken_words=${wordCount} ` +
        `min_words=${minWords} bot_speaking=${pyBool(this._botSpeaking)} interim_transcription=${pyBool(isInterim)}`,
    );

    if (shouldTrigger) {
      await this.triggerUserTurnStarted();
      return ProcessFrameResult.STOP;
    }
    await this.triggerResetAggregation();

    return ProcessFrameResult.CONTINUE;
  }
}

function pyBool(value: boolean): string {
  return value ? "True" : "False";
}
