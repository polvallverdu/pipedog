// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/metrics/frame_processor_metrics.py

/** Frame processor metrics collection and reporting. */

import { time } from "@pipedog/asyncio";
import { detectSpeechOnset } from "../../audio/utils.ts";
import { MetricsFrame } from "../../frames/frames.ts";
import {
  type LLMTokenUsage,
  LLMUsageMetricsData,
  MetricsData,
  ProcessingMetricsData,
  type STTUsage,
  STTUsageMetricsData,
  TextAggregationMetricsData,
  TTFAMetricsData,
  TTFATMetricsData,
  TTFBMetricsData,
  TTSUsageMetricsData,
} from "../../metrics/metrics.ts";
import { BaseObject } from "../../utils/base_object.ts";
import { logger } from "../../utils/logger.ts";

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Metrics collection and reporting for frame processors.
 *
 * Provides comprehensive metrics tracking for frame processing operations,
 * including timing measurements, resource usage, and performance analytics.
 * Supports TTFB tracking, TTFA tracking, processing duration metrics, and
 * usage statistics for LLM, STT, and TTS operations.
 */
export class FrameProcessorMetrics extends BaseObject {
  // Cap on buffered audio while waiting for a TTFA speech onset, so a response
  // that is all silence (or never becomes audible) can't grow the buffer without
  // bound.
  protected static readonly _TTFA_MAX_BUFFER_SECONDS = 3.0;

  protected _startTtfbTime = 0;
  protected _startProcessingTime = 0;
  protected _startTextAggregationTime = 0;
  protected _lastTtfbTime = 0;
  protected _shouldReportTtfb = true;
  // TTFA (time-to-first-audio) state. TTFA extends TTFB: scanning for the
  // first audible sample begins when TTFB stops (see stopTtfbMetrics).
  // Audio is buffered across chunks until a sustained onset is confirmed.
  protected _ttfaActive = false;
  protected _ttfaBuffer: Uint8Array = new Uint8Array(0);
  // TTFAT (time-to-first-answer-token) state. TTFAT extends TTFB the same
  // way, so it keeps the request start that stopTtfbMetrics clears.
  protected _ttfatActive = false;
  protected _startTtfatTime = 0;

  // Set by setProcessorName() / setCoreMetricsData(); FrameProcessor sets it
  // right after construction.
  protected _coreMetricsData!: MetricsData;

  /**
   * The current TTFB value in seconds, or null if not measured.
   */
  get ttfb(): number | null {
    if (this._lastTtfbTime > 0) {
      return this._lastTtfbTime;
    }

    // If TTFB is in progress, calculate current value
    if (this._startTtfbTime > 0) {
      return time() - this._startTtfbTime;
    }

    return null;
  }

  /** Get the processor name from core metrics data. */
  protected _processorName(): string {
    return this._coreMetricsData.processor;
  }

  /** Get the model name from core metrics data. */
  protected _modelName(): string | null {
    return this._coreMetricsData.model;
  }

  /**
   * Set the core metrics data for this collector.
   *
   * @param data The core metrics data containing processor and model information.
   */
  setCoreMetricsData(data: MetricsData): void {
    this._coreMetricsData = data;
  }

  /**
   * Set the processor name for metrics reporting.
   *
   * @param name The name of the processor to use in metrics.
   */
  setProcessorName(name: string): void {
    this._coreMetricsData = new MetricsData({ processor: name });
  }

  /**
   * Start measuring time-to-first-byte (TTFB).
   *
   * @param options.startTime Optional timestamp to use as the start time. If
   *   null, uses the current time.
   * @param options.reportOnlyInitialTtfb Whether to report only the first TTFB measurement.
   */
  async startTtfbMetrics(options: {
    startTime?: number | null;
    reportOnlyInitialTtfb: boolean;
  }): Promise<void> {
    // A response that was interrupted before its first answer token leaves
    // TTFAT armed; drop it so this request measures its own. This is TTFAT
    // state rather than TTFB reporting policy, so it happens regardless of
    // whether this request's TTFB will be reported.
    this._ttfatActive = false;
    this._startTtfatTime = 0;
    if (this._shouldReportTtfb) {
      // `||` on purpose: upstream uses `start_time or time.time()`.
      this._startTtfbTime = options.startTime || time();
      this._lastTtfbTime = 0;
      this._shouldReportTtfb = !options.reportOnlyInitialTtfb;
    }
  }

  /**
   * Abandon the current TTFB measurement without reporting it.
   *
   * For a request whose response never came: there is no interval to
   * report, and leaving the measurement open would let the next unrelated
   * output be measured against it.
   */
  async cancelTtfbMetrics(): Promise<void> {
    this._startTtfbTime = 0;
  }

  /**
   * Stop TTFB measurement and generate metrics frame.
   *
   * TTFB ends at the first output the service produces, of any kind —
   * including content a caller never sees, such as an LLM's reasoning. Events
   * that merely acknowledge the request (an HTTP response head, a stream-open
   * or keepalive event) carry no output and must not stop it, or TTFB
   * measures connection setup rather than the service's response.
   *
   * Only the first call per measurement takes effect, so services can call
   * this from every branch that handles output rather than tracking which
   * arrived first.
   *
   * @param options.endTime Optional timestamp to use as the end time. If null,
   *   uses the current time.
   * @returns MetricsFrame containing TTFB data, or null if not measuring.
   */
  async stopTtfbMetrics(options: { endTime?: number | null } = {}): Promise<MetricsFrame | null> {
    if (this._startTtfbTime === 0) {
      return null;
    }

    const endTime = options.endTime || time();

    if (endTime < this._startTtfbTime) {
      // The output being measured predates the request it is measured
      // from, so it cannot be a response to it -- a caller measuring to a
      // stale timestamp, or a wall clock that stepped backwards mid
      // measurement. Either way there is no interval to report.
      logger.warning(
        `${this._processorName()} TTFB not reported: output predates the ` +
          `start of the measurement by ${(this._startTtfbTime - endTime).toFixed(3)}s`,
      );
      this._startTtfbTime = 0;
      return null;
    }

    this._lastTtfbTime = endTime - this._startTtfbTime;
    logger.debug(`${this._processorName()} TTFB: ${this._lastTtfbTime.toFixed(3)}s`);
    const ttfb = new TTFBMetricsData({
      processor: this._processorName(),
      value: this._lastTtfbTime,
      model: this._modelName(),
    });
    // The first byte has arrived; begin scanning leading silence so TTFA can
    // be reported as TTFB plus the silence duration (see processTtfaMetrics).
    this._ttfaActive = true;
    this._ttfaBuffer = new Uint8Array(0);
    // Likewise for TTFAT, which needs the request start that is cleared below
    // (see stopTtfatMetrics).
    this._ttfatActive = true;
    this._startTtfatTime = this._startTtfbTime;
    this._startTtfbTime = 0;
    return new MetricsFrame({ data: [ttfb] });
  }

  /**
   * Scan buffered audio for speech onset and report TTFA.
   *
   * TTFA extends TTFB: once `stopTtfbMetrics` records the first byte, audio
   * is buffered across chunks (the leading silence may span several, and
   * onset confirmation needs a little audio past it) and scanned for a
   * sustained speech onset. When found, TTFB plus the leading-silence
   * duration is emitted and measuring stops until the next response.
   *
   * @param options.audio Raw PCM audio bytes (16-bit signed integers).
   * @param options.sampleRate Sample rate of the audio in Hz.
   * @param options.numChannels Number of interleaved audio channels.
   * @returns MetricsFrame containing TTFA data once onset is confirmed,
   *   otherwise null.
   */
  async processTtfaMetrics(options: {
    audio: Uint8Array;
    sampleRate: number;
    numChannels: number;
  }): Promise<MetricsFrame | null> {
    const { audio, sampleRate, numChannels } = options;
    if (!this._ttfaActive || sampleRate <= 0) {
      return null;
    }

    this._ttfaBuffer = concatBytes(this._ttfaBuffer, audio);
    const onset = detectSpeechOnset(this._ttfaBuffer, sampleRate, numChannels);
    if (onset === null || onset === undefined) {
      // No confirmed onset yet. Bound memory against pathologically long
      // (or never-arriving) silence by giving up past a sane limit.
      const maxSeconds = FrameProcessorMetrics._TTFA_MAX_BUFFER_SECONDS;
      const maxBytes = Math.trunc(maxSeconds * sampleRate * Math.max(numChannels, 1) * 2);
      if (this._ttfaBuffer.length >= maxBytes) {
        logger.debug(
          `${this._processorName()} TTFA: no onset within ` +
            `${maxSeconds.toFixed(0)}s of audio; not reporting`,
        );
        this._ttfaActive = false;
        this._ttfaBuffer = new Uint8Array(0);
      }
      return null;
    }

    const silenceDuration = onset / sampleRate;
    const value = this._lastTtfbTime + silenceDuration;
    logger.debug(
      `${this._processorName()} TTFA: ${value.toFixed(3)}s (${silenceDuration.toFixed(3)}s leading silence)`,
    );
    const ttfa = new TTFAMetricsData({
      processor: this._processorName(),
      ttfa: value,
      leadingSilence: silenceDuration,
      ttfb: this._lastTtfbTime,
      model: this._modelName(),
    });
    this._ttfaActive = false;
    this._ttfaBuffer = new Uint8Array(0);
    return new MetricsFrame({ data: [ttfa] });
  }

  /**
   * Stop TTFAT measurement and generate metrics frame.
   *
   * TTFAT extends TTFB: it runs from the same request start but ends at the
   * first token of the answer the caller sees, so anything the model streams
   * first — reasoning, most often — falls between the two. Measuring it at
   * the point a service produces the token, rather than where the pipeline
   * releases it, keeps buffering downstream of the service out of the number.
   *
   * Only the first call per measurement takes effect, so services can call
   * this from every branch that produces an answer — streamed text, and the
   * start of a tool call on a turn that answers with one instead of text.
   *
   * @param options.endTime Optional timestamp to use as the end time. If null,
   *   uses the current time.
   * @returns MetricsFrame containing TTFAT data, or null if not measuring.
   */
  async stopTtfatMetrics(options: { endTime?: number | null } = {}): Promise<MetricsFrame | null> {
    if (!this._ttfatActive || this._startTtfatTime === 0) {
      return null;
    }

    const endTime = options.endTime || time();

    const value = endTime - this._startTtfatTime;
    const thinkingTime = value - this._lastTtfbTime;
    logger.debug(
      `${this._processorName()} TTFAT: ${value.toFixed(3)}s (${thinkingTime.toFixed(3)}s thinking)`,
    );
    const ttfat = new TTFATMetricsData({
      processor: this._processorName(),
      ttfat: value,
      ttfb: this._lastTtfbTime,
      thinkingTime,
      model: this._modelName(),
    });
    this._ttfatActive = false;
    this._startTtfatTime = 0;
    return new MetricsFrame({ data: [ttfat] });
  }

  /**
   * Start measuring processing time.
   *
   * @param options.startTime Optional timestamp to use as the start time. If
   *   null, uses the current time.
   */
  async startProcessingMetrics(options: { startTime?: number | null } = {}): Promise<void> {
    this._startProcessingTime = options.startTime || time();
  }

  /**
   * Stop processing time measurement and generate metrics frame.
   *
   * @param options.endTime Optional timestamp to use as the end time. If null,
   *   uses the current time.
   * @returns MetricsFrame containing processing duration data, or null if not measuring.
   */
  async stopProcessingMetrics(
    options: { endTime?: number | null } = {},
  ): Promise<MetricsFrame | null> {
    if (this._startProcessingTime === 0) {
      return null;
    }

    const endTime = options.endTime || time();

    const value = endTime - this._startProcessingTime;
    logger.debug(`${this._processorName()} processing time: ${value.toFixed(3)}s`);
    const processing = new ProcessingMetricsData({
      processor: this._processorName(),
      value,
      model: this._modelName(),
    });
    this._startProcessingTime = 0;
    return new MetricsFrame({ data: [processing] });
  }

  /**
   * Record LLM token usage metrics.
   *
   * @param tokens Token usage information including prompt and completion tokens.
   * @returns MetricsFrame containing LLM usage data.
   */
  async startLlmUsageMetrics(tokens: LLMTokenUsage): Promise<MetricsFrame> {
    let logstr = `${this._processorName()} prompt tokens: ${tokens.promptTokens}, completion tokens: ${tokens.completionTokens}`;
    if (tokens.cacheReadInputTokens) {
      logstr += `, cache read input tokens: ${tokens.cacheReadInputTokens}`;
    }
    if (tokens.cacheCreationInputTokens) {
      logstr += `, cache creation input tokens: ${tokens.cacheCreationInputTokens}`;
    }
    if (tokens.reasoningTokens) {
      logstr += `, reasoning tokens: ${tokens.reasoningTokens}`;
    }
    if (tokens.inputAudioTokens) {
      logstr += `, input audio tokens: ${tokens.inputAudioTokens}`;
    }
    if (tokens.outputAudioTokens) {
      logstr += `, output audio tokens: ${tokens.outputAudioTokens}`;
    }
    if (tokens.cacheReadInputAudioTokens) {
      logstr += `, cache read input audio tokens: ${tokens.cacheReadInputAudioTokens}`;
    }
    logger.debug(logstr);
    const value = new LLMUsageMetricsData({
      processor: this._processorName(),
      model: this._modelName(),
      value: tokens,
    });
    return new MetricsFrame({ data: [value] });
  }

  /**
   * Record STT usage metrics.
   *
   * @param usage Usage information for the STT operation.
   * @returns MetricsFrame containing STT usage data.
   */
  async startSttUsageMetrics(usage: STTUsage): Promise<MetricsFrame> {
    logger.debug(`${this._processorName()} usage audio seconds: ${usage.audioSeconds.toFixed(3)}`);
    const value = new STTUsageMetricsData({
      processor: this._processorName(),
      model: this._modelName(),
      value: usage,
    });
    return new MetricsFrame({ data: [value] });
  }

  /**
   * Record TTS character usage metrics.
   *
   * @param text The text being processed by TTS.
   * @returns MetricsFrame containing TTS usage data.
   */
  async startTtsUsageMetrics(text: string): Promise<MetricsFrame> {
    const characters = new TTSUsageMetricsData({
      processor: this._processorName(),
      model: this._modelName(),
      // Python's len() counts code points, not UTF-16 units.
      value: [...text].length,
    });
    logger.debug(`${this._processorName()} usage characters: ${characters.value}`);
    return new MetricsFrame({ data: [characters] });
  }

  /** Start measuring text aggregation time (first token to first sentence). */
  async startTextAggregationMetrics(): Promise<void> {
    this._startTextAggregationTime = time();
  }

  /**
   * Stop text aggregation measurement and generate metrics frame.
   *
   * @returns MetricsFrame containing text aggregation time, or null if not measuring.
   */
  async stopTextAggregationMetrics(): Promise<MetricsFrame | null> {
    if (this._startTextAggregationTime === 0) {
      return null;
    }

    const value = time() - this._startTextAggregationTime;
    logger.debug(`${this._processorName()} text aggregation time: ${value}`);
    const aggregation = new TextAggregationMetricsData({
      processor: this._processorName(),
      value,
      model: this._modelName(),
    });
    this._startTextAggregationTime = 0;
    return new MetricsFrame({ data: [aggregation] });
  }
}
