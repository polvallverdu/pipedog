// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/loggers/metrics_log_observer.py

/**
 * Metrics logging observer for Pipecat.
 *
 * This module provides an observer that logs metrics frames to the console,
 * allowing developers to monitor performance metrics, token usage, and other
 * statistics in real-time.
 */

import { MetricsFrame } from "../../frames/frames.ts";
import {
  type LLMTokenUsage,
  LLMUsageMetricsData,
  type MetricsData,
  ProcessingMetricsData,
  STTUsageMetricsData,
  TTFAMetricsData,
  TTFATMetricsData,
  TTFBMetricsData,
  TTSUsageMetricsData,
  TurnMetricsData,
} from "../../metrics/metrics.ts";
import { logger } from "../../utils/logger.ts";
import { BaseObserver, type BaseObserverOptions, type FramePushed } from "../base_observer.ts";

export type MetricsDataClass = abstract new (...args: any[]) => MetricsData;

export interface MetricsLogObserverOptions extends Omit<BaseObserverOptions, "observeEveryPush"> {
  /**
   * Set of metrics types to include. If specified, only these metrics types
   * will be logged. If null, all metrics are logged.
   */
  includeMetrics?: ReadonlySet<MetricsDataClass> | null;
}

/**
 * Observer to log metrics activity to the console.
 *
 * Monitors and logs all MetricsFrame instances, including:
 *
 * - TTFBMetricsData (Time To First Byte)
 * - TTFAMetricsData (Time To First Audio)
 * - TTFATMetricsData (Time To First Answer Token)
 * - ProcessingMetricsData (General processing time)
 * - LLMUsageMetricsData (Token usage statistics)
 * - STTUsageMetricsData (Speech-to-Text audio seconds)
 * - TTSUsageMetricsData (Text-to-Speech character counts)
 * - TurnMetricsData (Turn prediction metrics)
 *
 * This allows developers to track performance metrics, token usage, and other
 * statistics throughout the pipeline.
 *
 * @example
 * // Log all metrics types
 * const observers = [new MetricsLogObserver()];
 *
 * // Log only LLM and TTS metrics
 * const observers = [
 *   new MetricsLogObserver({
 *     includeMetrics: new Set([LLMUsageMetricsData, TTSUsageMetricsData]),
 *   }),
 * ];
 */
export class MetricsLogObserver extends BaseObserver {
  protected _includeMetrics: ReadonlySet<MetricsDataClass> | null;

  /** Initialize the metrics log observer. */
  constructor(options: MetricsLogObserverOptions = {}) {
    super({ ...options, observeEveryPush: false });
    this._includeMetrics = options.includeMetrics ?? null;
  }

  /**
   * Handle frame push events and log metrics frames.
   *
   * Logs MetricsFrame instances with detailed information about the metrics
   * data, formatted appropriately for each metrics type.
   *
   * @param data Frame push event data containing source, frame, and timestamp.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    const frame = data.frame;
    const timestamp = data.timestamp;

    if (!(frame instanceof MetricsFrame)) {
      return;
    }

    const timeSec = timestamp / 1_000_000_000;

    // Process each metrics data item in the frame
    for (const metricsData of frame.data) {
      // Check if this metrics type should be logged
      if (!this._shouldLogMetrics(metricsData)) {
        continue;
      }

      this._logMetricsData(metricsData, timeSec);
    }
  }

  /**
   * Determine if a metrics data item should be logged based on filters.
   *
   * @param metricsData The metrics data to check.
   * @returns True if the metrics should be logged, false otherwise.
   */
  protected _shouldLogMetrics(metricsData: MetricsData): boolean {
    // If includeMetrics is specified, only log those types
    if (this._includeMetrics !== null) {
      return this._includeMetrics.has(metricsData.constructor as MetricsDataClass);
    }

    // Otherwise, log all metrics
    return true;
  }

  /**
   * Log a single metrics data item.
   *
   * @param metricsData The metrics data to log.
   * @param timeSec Timestamp in seconds.
   */
  protected _logMetricsData(metricsData: MetricsData, timeSec: number): void {
    const processorInfo = `[${metricsData.processor}]`;
    const modelInfo = metricsData.model ? ` (${metricsData.model})` : "";
    const t = timeSec.toFixed(3);

    if (metricsData instanceof TTFBMetricsData) {
      logger.debug(`📊 ${processorInfo} TTFB${modelInfo}: ${metricsData.value}s at ${t}s`);
    } else if (metricsData instanceof TTFAMetricsData) {
      logger.debug(
        `📊 ${processorInfo} TTFA${modelInfo}: ${metricsData.ttfa}s ` +
          `(${metricsData.leadingSilence}s leading silence) at ${t}s`,
      );
    } else if (metricsData instanceof TTFATMetricsData) {
      logger.debug(
        `📊 ${processorInfo} TTFAT${modelInfo}: ${metricsData.ttfat}s ` +
          `(${metricsData.thinkingTime}s thinking) at ${t}s`,
      );
    } else if (metricsData instanceof ProcessingMetricsData) {
      logger.debug(
        `📊 ${processorInfo} PROCESSING TIME${modelInfo}: ${metricsData.value}s at ${t}s`,
      );
    } else if (metricsData instanceof LLMUsageMetricsData) {
      this._logLlmUsage(metricsData, processorInfo, modelInfo, timeSec);
    } else if (metricsData instanceof STTUsageMetricsData) {
      logger.debug(
        `📊 ${processorInfo} STT USAGE${modelInfo}: ` +
          `${metricsData.value.audioSeconds.toFixed(3)}s audio at ${t}s`,
      );
    } else if (metricsData instanceof TTSUsageMetricsData) {
      logger.debug(
        `📊 ${processorInfo} TTS USAGE${modelInfo}: ${metricsData.value} characters at ${t}s`,
      );
    } else if (metricsData instanceof TurnMetricsData) {
      this._logTurn(metricsData, processorInfo, modelInfo, timeSec);
    } else {
      // Generic fallback for unknown metrics types
      logger.debug(`📊 ${processorInfo} METRICS${modelInfo}: ${metricsData} at ${t}s`);
    }
  }

  /**
   * Log LLM token usage metrics.
   *
   * @param metricsData The LLM usage metrics data.
   * @param processorInfo Formatted processor name string.
   * @param modelInfo Formatted model name string.
   * @param timeSec Timestamp in seconds.
   */
  protected _logLlmUsage(
    metricsData: LLMUsageMetricsData,
    processorInfo: string,
    modelInfo: string,
    timeSec: number,
  ): void {
    const usage: LLMTokenUsage = metricsData.value;

    // Build usage details
    const details = [
      `prompt: ${usage.promptTokens}`,
      `completion: ${usage.completionTokens}`,
      `total: ${usage.totalTokens}`,
    ];

    if (usage.cacheReadInputTokens !== null && usage.cacheReadInputTokens !== undefined) {
      details.push(`cache_read: ${usage.cacheReadInputTokens}`);
    }

    if (usage.cacheCreationInputTokens !== null && usage.cacheCreationInputTokens !== undefined) {
      details.push(`cache_creation: ${usage.cacheCreationInputTokens}`);
    }

    if (usage.reasoningTokens !== null && usage.reasoningTokens !== undefined) {
      details.push(`reasoning: ${usage.reasoningTokens}`);
    }

    if (usage.inputAudioTokens !== null && usage.inputAudioTokens !== undefined) {
      details.push(`input_audio: ${usage.inputAudioTokens}`);
    }

    if (usage.outputAudioTokens !== null && usage.outputAudioTokens !== undefined) {
      details.push(`output_audio: ${usage.outputAudioTokens}`);
    }

    if (usage.cacheReadInputAudioTokens !== null && usage.cacheReadInputAudioTokens !== undefined) {
      details.push(`cache_read_audio: ${usage.cacheReadInputAudioTokens}`);
    }

    const usageStr = details.join(", ");

    logger.debug(
      `📊 ${processorInfo} LLM TOKEN USAGE${modelInfo}: ${usageStr} at ${timeSec.toFixed(2)}s`,
    );
  }

  /**
   * Log turn prediction metrics.
   *
   * @param metricsData The turn metrics data.
   * @param processorInfo Formatted processor name string.
   * @param modelInfo Formatted model name string.
   * @param timeSec Timestamp in seconds.
   */
  protected _logTurn(
    metricsData: TurnMetricsData,
    processorInfo: string,
    modelInfo: string,
    timeSec: number,
  ): void {
    const completeStr = metricsData.isComplete ? "COMPLETE" : "INCOMPLETE";
    const e2eStr = `${metricsData.e2eProcessingTimeMs.toFixed(1)}ms`;

    logger.debug(
      `📊 ${processorInfo} TURN${modelInfo}: ${completeStr} ` +
        `(probability: ${(metricsData.probability * 100).toFixed(2)}%, ` +
        `e2e: ${e2eStr}) ` +
        `at ${timeSec.toFixed(2)}s`,
    );
  }
}
