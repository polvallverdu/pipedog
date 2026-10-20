// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/turn/smart_turn/base_smart_turn.py

/**
 * Smart turn analyzer base class using ML models for end-of-turn detection.
 *
 * Provides the base implementation for smart turn analyzers that use machine
 * learning models to determine when a user has finished speaking, going
 * beyond simple silence-based detection.
 */

import { abortable, monotonic } from "@pipedog/asyncio";
import { type MetricsData, TurnMetricsData } from "../../../metrics/metrics.ts";
import { logger } from "../../../utils/logger.ts";
import {
  BaseTurnAnalyzer,
  type BaseTurnAnalyzerOptions,
  BaseTurnParams,
  EndOfTurnState,
} from "../base_turn_analyzer.ts";

// Default timing parameters
export const STOP_SECS = 3;
export const PRE_SPEECH_MS = 500;
export const MAX_DURATION_SECONDS = 8; // Max allowed segment duration

export interface SmartTurnParamsOptions {
  /** Maximum silence duration in seconds before ending turn. */
  stopSecs?: number;
  /** Milliseconds of audio to include before speech starts. */
  preSpeechMs?: number;
  /** Maximum duration in seconds for audio segments. */
  maxDurationSecs?: number;
}

/** Configuration parameters for smart turn analysis. */
export class SmartTurnParams extends BaseTurnParams {
  stopSecs: number;
  preSpeechMs: number;
  maxDurationSecs: number;

  constructor(options: SmartTurnParamsOptions = {}) {
    super(options);
    this.stopSecs = options.stopSecs ?? STOP_SECS;
    this.preSpeechMs = options.preSpeechMs ?? PRE_SPEECH_MS;
    this.maxDurationSecs = options.maxDurationSecs ?? MAX_DURATION_SECONDS;
  }

  override toString(): string {
    return (
      `stop_secs=${this.stopSecs} pre_speech_ms=${this.preSpeechMs} ` +
      `max_duration_secs=${this.maxDurationSecs}`
    );
  }
}

/** Exception raised when smart turn analysis times out. */
export class SmartTurnTimeoutException extends Error {
  override name = "SmartTurnTimeoutException";
}

/** Result of a model prediction: `prediction` is 1 for complete, 0 otherwise. */
export interface SmartTurnPrediction {
  prediction: number;
  probability: number;
  [key: string]: unknown;
}

export interface BaseSmartTurnOptions extends BaseTurnAnalyzerOptions {
  /** Configuration parameters for turn analysis behavior. */
  params?: SmartTurnParams | null;
}

function endOfTurnStateName(state: EndOfTurnState): string {
  return state === EndOfTurnState.COMPLETE
    ? "EndOfTurnState.COMPLETE"
    : "EndOfTurnState.INCOMPLETE";
}

/**
 * Base class for smart turn analyzers using ML models.
 *
 * Provides common functionality for smart turn detection including audio
 * buffering, speech tracking, and ML model integration. Subclasses must
 * implement the specific model prediction logic.
 *
 * Upstream runs the model on a dedicated thread; there are no threads on every
 * runtime we target, so prediction is an async method run inline.
 */
export abstract class BaseSmartTurn extends BaseTurnAnalyzer {
  protected _params: SmartTurnParams;
  // Configuration
  protected _stopMs: number;
  // Inference state
  protected _audioBuffer: [number, Int16Array][] = [];
  protected _speechTriggered = false;
  protected _silenceMs = 0;
  protected _speechStartTime = 0;
  protected _vadStartSecs = 0.0;

  constructor(options: BaseSmartTurnOptions = {}) {
    super(options);
    this._params = options.params ?? new SmartTurnParams();
    this._stopMs = this._params.stopSecs * 1000; // silence threshold in ms
  }

  /** Whether speech has been detected and turn analysis is active. */
  get speechTriggered(): boolean {
    return this._speechTriggered;
  }

  /** The current smart turn configuration parameters. */
  get params(): SmartTurnParams {
    return this._params;
  }

  /**
   * Append audio data for turn analysis.
   *
   * @param buffer Raw audio data bytes to append for analysis.
   * @param isSpeech Whether the audio buffer contains detected speech.
   * @returns Current end-of-turn state after processing the audio.
   */
  appendAudio(buffer: Uint8Array, isSpeech: boolean): EndOfTurnState {
    // Append the raw int16 PCM view to the buffer. Conversion to float32 is
    // deferred until _processSpeechSegment, where it runs once per turn on
    // the concatenated segment instead of once per ~20 ms audio frame. The
    // samples are copied so later mutation of the caller's buffer can't leak
    // in (Python relies on `bytes` being immutable).
    const audioInt16 = new Int16Array(buffer.slice(0, buffer.length - (buffer.length % 2)).buffer);
    this._audioBuffer.push([monotonic(), audioInt16]);

    let state: EndOfTurnState = EndOfTurnState.INCOMPLETE;

    if (isSpeech) {
      // Reset silence tracking on speech
      this._silenceMs = 0;
      this._speechTriggered = true;
      if (this._speechStartTime === 0) {
        this._speechStartTime = monotonic();
      }
    } else {
      if (this._speechTriggered) {
        const chunkDurationMs = audioInt16.length / (this._sampleRate / 1000);
        this._silenceMs += chunkDurationMs;
        // If silence exceeds threshold, mark end of turn
        if (this._silenceMs >= this._stopMs) {
          logger.debug(`End of Turn complete due to stop_secs. Silence in ms: ${this._silenceMs}`);
          state = EndOfTurnState.COMPLETE;
          this._clear(state);
        }
      } else {
        // Trim buffer to prevent unbounded growth before speech
        const maxBufferTime =
          this._params.preSpeechMs / 1000 + this._params.stopSecs + this._params.maxDurationSecs;
        while (
          this._audioBuffer.length > 0 &&
          (this._audioBuffer[0] as [number, Int16Array])[0] < monotonic() - maxBufferTime
        ) {
          this._audioBuffer.shift();
        }
      }
    }

    return state;
  }

  /**
   * Analyze the current audio state to determine if turn has ended.
   *
   * @returns The end-of-turn state and optional metrics data from the ML
   *   model analysis.
   */
  async analyzeEndOfTurn(): Promise<[EndOfTurnState, MetricsData | null]> {
    const [state, result] = await this._processSpeechSegment(this._audioBuffer);
    if (state === EndOfTurnState.COMPLETE) {
      this._clear(state);
    }
    logger.debug(`End of Turn result: ${endOfTurnStateName(state)}`);
    return [state, result];
  }

  /** Store the new vadStartSecs value. */
  override updateVadStartSecs(vadStartSecs: number): void {
    this._vadStartSecs = vadStartSecs;
  }

  /** Reset the turn analyzer to its initial state. */
  clear(): void {
    this._clear(EndOfTurnState.COMPLETE);
  }

  /**
   * Release the analyzer's resources.
   *
   * The analyzer stays usable: cleaning up is not only teardown here, since a
   * turn strategy is cleaned up and re-applied whenever the strategies are
   * updated. (Upstream stops its model thread here; there is none in the
   * port.)
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();
  }

  /** Clear internal state based on turn completion status. */
  protected _clear(turnState: EndOfTurnState): void {
    // If the state is still incomplete, keep the _speechTriggered as true
    this._speechTriggered = turnState === EndOfTurnState.INCOMPLETE;
    this._audioBuffer = [];
    this._speechStartTime = 0;
    this._silenceMs = 0;
  }

  /** Process accumulated audio segment using ML model. */
  protected async _processSpeechSegment(
    audioBuffer: [number, Int16Array][],
  ): Promise<[EndOfTurnState, MetricsData | null]> {
    let state: EndOfTurnState = EndOfTurnState.INCOMPLETE;

    if (audioBuffer.length === 0) {
      return [state, null];
    }

    // Extract recent audio segment for prediction
    const effectivePreSpeechMs = this._params.preSpeechMs + this._vadStartSecs * 1000;
    const startTime = this._speechStartTime - effectivePreSpeechMs / 1000;
    let startIndex = 0;
    for (let i = 0; i < audioBuffer.length; i++) {
      const [t] = audioBuffer[i] as [number, Int16Array];
      if (t >= startTime) {
        startIndex = i;
        break;
      }
    }

    const endIndex = audioBuffer.length - 1;

    // Extract the audio segment. The buffer holds int16 PCM; defer the
    // float32 conversion until after concatenation so it runs once per turn
    // instead of once per appended frame.
    const segmentChunks = audioBuffer.slice(startIndex, endIndex + 1).map(([, chunk]) => chunk);
    const totalLength = segmentChunks.reduce((n, chunk) => n + chunk.length, 0);
    let segmentAudio = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of segmentChunks) {
      for (let i = 0; i < chunk.length; i++) {
        segmentAudio[offset + i] = (chunk[i] as number) / 32768.0;
      }
      offset += chunk.length;
    }

    // Limit maximum duration
    const maxSamples = Math.trunc(this._params.maxDurationSecs * this.sampleRate);
    if (segmentAudio.length > maxSamples) {
      // Keep the last maxSamples samples, discarding the earlier part.
      segmentAudio = segmentAudio.slice(segmentAudio.length - maxSamples);
    }

    let resultData: TurnMetricsData | null = null;

    if (segmentAudio.length > 0) {
      const start = performance.now();
      try {
        // Upstream awaits the model on an executor, which is a cancellation
        // point; `abortable` keeps it one here.
        const result = await abortable(this._predictEndpoint(segmentAudio));
        state = result.prediction === 1 ? EndOfTurnState.COMPLETE : EndOfTurnState.INCOMPLETE;
        const end = performance.now();

        // Calculate processing time
        const e2eProcessingTimeMs = end - start;

        // Prepare the result data
        resultData = new TurnMetricsData({
          processor: "BaseSmartTurn",
          isComplete: result.prediction === 1,
          probability: result.probability,
          e2eProcessingTimeMs,
        });

        logger.trace(`Prediction: ${resultData.isComplete ? "Complete" : "Incomplete"}`);
        logger.trace(`Probability of complete: ${resultData.probability.toFixed(4)}`);
        logger.trace(`E2E processing time: ${resultData.e2eProcessingTimeMs.toFixed(2)}ms`);
      } catch (e) {
        if (!(e instanceof SmartTurnTimeoutException)) throw e;
        logger.debug(`End of Turn complete due to stop_secs. Silence in ms: ${this._silenceMs}`);
        state = EndOfTurnState.COMPLETE;
      }
    } else {
      logger.trace(`params: ${this._params}, stop_ms: ${this._stopMs}`);
      logger.trace("Captured empty audio segment, skipping prediction.");
    }

    return [state, resultData];
  }

  /** Predict end-of-turn using ML model from audio data. */
  protected abstract _predictEndpoint(audioArray: Float32Array): Promise<SmartTurnPrediction>;
}
