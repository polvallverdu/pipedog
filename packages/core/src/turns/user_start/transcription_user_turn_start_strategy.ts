// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/turns/user_start/transcription_user_turn_start_strategy.py

/** User turn start strategy based on transcriptions. */

import { type Frame, InterimTranscriptionFrame, TranscriptionFrame } from "../../frames/frames.ts";
import { ProcessFrameResult } from "../types.ts";
import {
  BaseUserTurnStartStrategy,
  type BaseUserTurnStartStrategyOptions,
} from "./base_user_turn_start_strategy.ts";

export interface TranscriptionUserTurnStartStrategyOptions
  extends BaseUserTurnStartStrategyOptions {
  /** Whether interim transcriptions also start a turn. */
  useInterim?: boolean;
}

/**
 * User turn start strategy based on transcriptions.
 *
 * This strategy signals the start of a user turn when a transcription is
 * received while the bot is speaking. It is useful as a fallback in scenarios
 * where VAD-based detection fails (for example, when the user speaks very
 * softly) but the STT service still produces transcriptions.
 */
export class TranscriptionUserTurnStartStrategy extends BaseUserTurnStartStrategy {
  protected _useInterim: boolean;

  /** Initialize transcription-based user turn start strategy. */
  constructor(options: TranscriptionUserTurnStartStrategyOptions = {}) {
    super(options);
    this._useInterim = options.useInterim ?? true;
  }

  /**
   * Process an incoming frame to detect the start of a user turn.
   *
   * @param frame The frame to be processed.
   * @returns STOP if a transcription was received, CONTINUE otherwise.
   */
  override async processFrame(frame: Frame): Promise<ProcessFrameResult> {
    if (frame instanceof InterimTranscriptionFrame && this._useInterim) {
      await this.triggerUserTurnStarted();
      return ProcessFrameResult.STOP;
    } else if (frame instanceof TranscriptionFrame) {
      await this.triggerUserTurnStarted();
      return ProcessFrameResult.STOP;
    }

    return ProcessFrameResult.CONTINUE;
  }
}
