// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/turn/base_turn_analyzer.py

/**
 * Base turn analyzer for determining end-of-turn in audio conversations.
 *
 * Provides the abstract base class and enumeration for analyzing when a user
 * has finished speaking in a conversation.
 */

import type { MetricsData } from "../../metrics/metrics.ts";

/**
 * State enumeration for end-of-turn analysis results.
 *
 * - COMPLETE: the user has finished their turn and stopped speaking.
 * - INCOMPLETE: the user is still speaking or may continue speaking.
 */
export const EndOfTurnState = {
  COMPLETE: 1,
  INCOMPLETE: 2,
} as const;
export type EndOfTurnState = (typeof EndOfTurnState)[keyof typeof EndOfTurnState];

/** Base class for turn analyzer parameters. */
export class BaseTurnParams {
  // Takes the options object so subclasses can forward it (Python **kwargs).
  constructor(_options: object = {}) {}
}

export interface BaseTurnAnalyzerOptions {
  /**
   * Optional initial sample rate for audio processing. If provided, this
   * will be used as the fixed sample rate.
   */
  sampleRate?: number | null;
}

/**
 * Abstract base class for analyzing user end of turn.
 *
 * Defines the interface through abstract methods; subclasses implement the
 * actual analysis.
 */
export abstract class BaseTurnAnalyzer {
  protected _initSampleRate: number | null;
  protected _sampleRate = 0;

  constructor(options: BaseTurnAnalyzerOptions = {}) {
    this._initSampleRate = options.sampleRate ?? null;
  }

  /** The effective sample rate for audio processing. */
  get sampleRate(): number {
    return this._sampleRate;
  }

  /**
   * Sets the sample rate for audio processing.
   *
   * If the initial sample rate was provided, it will use that; otherwise, it
   * sets to the provided sample rate.
   *
   * @param sampleRate The sample rate to set.
   */
  setSampleRate(sampleRate: number): void {
    this._sampleRate = this._initSampleRate || sampleRate;
  }

  /** Whether speech has been detected. */
  abstract get speechTriggered(): boolean;

  /** The current turn analyzer configuration parameters. */
  abstract get params(): BaseTurnParams;

  /**
   * Appends audio data for analysis.
   *
   * @param buffer The audio data to append.
   * @param isSpeech Indicates whether the appended audio is speech or not.
   * @returns The resulting state after appending the audio.
   */
  abstract appendAudio(buffer: Uint8Array, isSpeech: boolean): EndOfTurnState;

  /**
   * Analyzes if an end of turn has occurred based on the audio input.
   *
   * @returns The result of the end of turn analysis and optional metrics.
   */
  abstract analyzeEndOfTurn(): Promise<[EndOfTurnState, MetricsData | null]>;

  /**
   * Update the VAD start trigger time.
   *
   * The turn analyzer may choose to change its buffer size depending on this
   * value.
   *
   * @param vadStartSecs The number of seconds of voice activity before
   *   triggering the user speaking event.
   */
  updateVadStartSecs(_vadStartSecs: number): void {}

  /** Reset the turn analyzer to its initial state. */
  abstract clear(): void;

  /** Cleanup the turn analyzer. */
  async cleanup(): Promise<void> {}
}
