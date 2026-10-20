// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/audio/vad/vad_analyzer.py

/**
 * Voice Activity Detection (VAD) analyzer base classes and utilities.
 *
 * Provides the abstract base class for VAD analyzers and associated data
 * structures for voice activity detection in audio streams. Includes state
 * management, parameter configuration, and audio analysis framework.
 */

import { logger } from "../../utils/logger.ts";
import { expSmoothing } from "../utils.ts";
import { AudioVolumeTracker } from "../volume.ts";

export const VAD_CONFIDENCE = 0.7;
export const VAD_START_SECS = 0.2;
export const VAD_STOP_SECS = 0.2;
export const VAD_MIN_VOLUME = 0.6;

/**
 * Voice Activity Detection states.
 *
 * - QUIET: no voice activity detected.
 * - STARTING: voice activity beginning, transitioning from quiet.
 * - SPEAKING: active voice detected and confirmed.
 * - STOPPING: voice activity ending, transitioning to quiet.
 */
export const VADState = {
  QUIET: 1,
  STARTING: 2,
  SPEAKING: 3,
  STOPPING: 4,
} as const;
export type VADState = (typeof VADState)[keyof typeof VADState];

export interface VADParamsOptions {
  /** Minimum confidence threshold for voice detection. */
  confidence?: number;
  /** Duration to wait before confirming voice start. */
  startSecs?: number;
  /** Duration to wait before confirming voice stop. */
  stopSecs?: number;
  /** Minimum audio volume threshold for voice detection. */
  minVolume?: number;
}

/** Configuration parameters for Voice Activity Detection. */
export class VADParams {
  confidence: number;
  startSecs: number;
  stopSecs: number;
  minVolume: number;

  constructor(options: VADParamsOptions = {}) {
    this.confidence = options.confidence ?? VAD_CONFIDENCE;
    this.startSecs = options.startSecs ?? VAD_START_SECS;
    this.stopSecs = options.stopSecs ?? VAD_STOP_SECS;
    this.minVolume = options.minVolume ?? VAD_MIN_VOLUME;
  }

  toString(): string {
    return (
      `confidence=${this.confidence} start_secs=${this.startSecs} ` +
      `stop_secs=${this.stopSecs} min_volume=${this.minVolume}`
    );
  }
}

export interface VADAnalyzerOptions {
  /** Audio sample rate in Hz. If null, will be set later. */
  sampleRate?: number | null;
  /** VAD parameters for detection configuration. */
  params?: VADParams | null;
}

/**
 * Abstract base class for Voice Activity Detection analyzers.
 *
 * Provides the framework for implementing VAD analysis with configurable
 * parameters, state management, and audio processing capabilities.
 * Subclasses must implement the core voice confidence calculation.
 *
 * Upstream runs the model on a single-thread executor; there are no threads
 * on every runtime we target, so the analysis runs inline.
 */
export abstract class VADAnalyzer {
  protected _initSampleRate: number | null;
  protected _sampleRate = 0;
  protected _params: VADParams;
  protected _numChannels = 1;

  protected _vadBuffer: Uint8Array = new Uint8Array(0);
  protected _volumeTracker = new AudioVolumeTracker();

  // Volume exponential smoothing
  protected _smoothingFactor = 0.2;
  protected _prevVolume = 0.0;

  protected _vadFrames = 0;
  protected _vadFramesNumBytes = 0;
  protected _vadStartFrames = 0;
  protected _vadStopFrames = 0;
  protected _vadStartingCount = 0;
  protected _vadStoppingCount = 0;
  protected _vadState: VADState = VADState.QUIET;

  constructor(options: VADAnalyzerOptions = {}) {
    this._initSampleRate = options.sampleRate ?? null;
    this._params = options.params ?? new VADParams();
  }

  /** Current audio sample rate in Hz. */
  get sampleRate(): number {
    return this._sampleRate;
  }

  /** Number of audio channels (always 1 for mono). */
  get numChannels(): number {
    return this._numChannels;
  }

  /** Current VAD configuration parameters. */
  get params(): VADParams {
    return this._params;
  }

  /**
   * Get the number of audio frames required for analysis.
   *
   * @returns Number of frames needed for VAD processing.
   */
  abstract numFramesRequired(): number;

  /**
   * Calculate voice activity confidence for the given audio buffer.
   *
   * May return a promise: JavaScript ONNX runtimes only run models
   * asynchronously. Upstream calls this on the analyzer's model thread.
   *
   * @param buffer Audio buffer to analyze.
   * @returns Voice confidence score between 0.0 and 1.0.
   */
  abstract voiceConfidence(buffer: Uint8Array): number | Promise<number>;

  /**
   * Set the sample rate for audio processing.
   *
   * @param sampleRate Audio sample rate in Hz.
   */
  setSampleRate(sampleRate: number): void {
    this._sampleRate = this._initSampleRate || sampleRate;
    this.setParams(this._params);
  }

  /**
   * Set VAD parameters and recalculate internal values.
   *
   * @param params VAD parameters for detection configuration.
   */
  setParams(params: VADParams): void {
    logger.debug(`Setting VAD params to: ${params}`);
    this._params = params;
    this._vadFrames = this.numFramesRequired();
    this._vadFramesNumBytes = this._vadFrames * this._numChannels * 2;

    const vadFramesPerSec = this._vadFrames / this.sampleRate;

    this._vadStartFrames = pyRound(this._params.startSecs / vadFramesPerSec);
    this._vadStopFrames = pyRound(this._params.stopSecs / vadFramesPerSec);
    // VAD state resets, but volume state doesn't: the rolling window and its
    // smoothing follow the audio stream, which is continuous across parameter
    // changes.
    this._vadStartingCount = 0;
    this._vadStoppingCount = 0;
    this._vadState = VADState.QUIET;
  }

  /** Calculate smoothed audio volume using exponential smoothing. */
  protected _getSmoothedVolume(audio: Uint8Array): number {
    this._volumeTracker.update(audio, this.sampleRate);
    return expSmoothing(this._volumeTracker.volume, this._prevVolume, this._smoothingFactor);
  }

  /**
   * Analyze audio buffer and return current VAD state.
   *
   * Processes incoming audio data, maintains internal state, and determines
   * voice activity status based on confidence and volume thresholds.
   *
   * @param buffer Audio buffer to analyze.
   * @returns Current VAD state after processing the buffer.
   */
  async analyzeAudio(buffer: Uint8Array): Promise<VADState> {
    // One buffer at a time, like upstream's single-thread executor: an
    // asynchronous model must not interleave two buffers' windows.
    while (this.#analyzing) await this.#analyzing;
    const state = this._runAnalyzer(buffer);
    if (!isPromiseLike(state)) return state;
    const done = Promise.resolve(state).then(
      () => {},
      () => {},
    );
    this.#analyzing = done;
    try {
      return await state;
    } finally {
      if (this.#analyzing === done) this.#analyzing = null;
    }
  }

  #analyzing: Promise<void> | null = null;

  /**
   * Analyze audio buffer and return current VAD state.
   *
   * Synchronous when `voiceConfidence` is; otherwise returns a promise.
   */
  protected _runAnalyzer(buffer: Uint8Array): VADState | Promise<VADState> {
    const combined = new Uint8Array(this._vadBuffer.length + buffer.length);
    combined.set(this._vadBuffer, 0);
    combined.set(buffer, this._vadBuffer.length);
    this._vadBuffer = combined;

    const numRequiredBytes = this._vadFramesNumBytes;
    if (this._vadBuffer.length < numRequiredBytes) {
      return this._vadState;
    }

    return this.#analyzeWindows();
  }

  /** Score every complete window in the buffer, then settle the state. */
  #analyzeWindows(): VADState | Promise<VADState> {
    const numRequiredBytes = this._vadFramesNumBytes;
    while (this._vadBuffer.length >= numRequiredBytes) {
      const audioFrames = this._vadBuffer.slice(0, numRequiredBytes);
      this._vadBuffer = this._vadBuffer.subarray(numRequiredBytes);

      const confidence = this.voiceConfidence(audioFrames);
      if (isPromiseLike(confidence)) {
        return Promise.resolve(confidence).then((c) => {
          this.#updateState(audioFrames, c);
          return this.#analyzeWindows();
        });
      }
      this.#updateState(audioFrames, confidence);
    }

    if (this._vadState === VADState.STARTING && this._vadStartingCount >= this._vadStartFrames) {
      this._vadState = VADState.SPEAKING;
      this._vadStartingCount = 0;
    }

    if (this._vadState === VADState.STOPPING && this._vadStoppingCount >= this._vadStopFrames) {
      this._vadState = VADState.QUIET;
      this._vadStoppingCount = 0;
    }

    return this._vadState;
  }

  /** Advance the state machine with one window's confidence. */
  #updateState(audioFrames: Uint8Array, confidence: number): void {
    const volume = this._getSmoothedVolume(audioFrames);
    this._prevVolume = volume;

    const speaking = confidence >= this._params.confidence && volume >= this._params.minVolume;

    if (speaking) {
      switch (this._vadState) {
        case VADState.QUIET:
          this._vadState = VADState.STARTING;
          this._vadStartingCount = 1;
          break;
        case VADState.STARTING:
          this._vadStartingCount += 1;
          break;
        case VADState.STOPPING:
          this._vadState = VADState.SPEAKING;
          this._vadStoppingCount = 0;
          break;
      }
    } else {
      switch (this._vadState) {
        case VADState.STARTING:
          this._vadState = VADState.QUIET;
          this._vadStartingCount = 0;
          break;
        case VADState.SPEAKING:
          this._vadState = VADState.STOPPING;
          this._vadStoppingCount = 1;
          break;
        case VADState.STOPPING:
          this._vadStoppingCount += 1;
          break;
      }
    }
  }

  /**
   * Release the analyzer's resources.
   *
   * This method should be called when the object is no longer needed.
   * (Upstream shuts down its model thread here; there is none in the port.)
   */
  async cleanup(): Promise<void> {}
}

function isPromiseLike<T>(x: T | PromiseLike<T>): x is PromiseLike<T> {
  return typeof (x as { then?: unknown } | null)?.then === "function";
}

/** Python's round(): half to even. */
function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
