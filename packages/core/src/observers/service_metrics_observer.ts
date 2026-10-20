// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/observers/service_metrics_observer.py

/**
 * Observer reporting what each service spent and consumed.
 *
 * Services report metrics as they finish a piece of work, and this observer
 * turns each one into a record: what was measured, which processor and model
 * reported it, and when. Nothing is summed, so a consumer groups the records
 * by turn, session or model as it needs, and a session that ends abruptly
 * still leaves behind everything that happened before it did.
 */

import { time } from "@pipedog/asyncio";
import { MetricsFrame } from "../frames/frames.ts";
import {
  LLMUsageMetricsData,
  type MetricsData,
  STTUsageMetricsData,
  TTFAMetricsData,
  TTFATMetricsData,
  TTFBMetricsData,
  TTSUsageMetricsData,
} from "../metrics/metrics.ts";
import { BaseObserver, type BaseObserverOptions, type FramePushed } from "./base_observer.ts";

/** Which measurement of a service's own time a record carries. */
export const ServiceLatencyKind = {
  TTFB: "ttfb",
  TTFA: "ttfa",
  TTFAT: "ttfat",
} as const;
export type ServiceLatencyKind = (typeof ServiceLatencyKind)[keyof typeof ServiceLatencyKind];

/** Which kind of service consumed something. */
export const ServiceUsageKind = {
  STT: "stt",
  LLM: "llm",
  TTS: "tts",
} as const;
export type ServiceUsageKind = (typeof ServiceUsageKind)[keyof typeof ServiceUsageKind];

export interface ServiceLatencyRecordOptions {
  /** Which wait was measured. */
  kind: ServiceLatencyKind;
  /** Name of the processor that reported it. */
  processor: string;
  /** Model the processor was using, where it names one. */
  model?: string | null;
  /** Unix timestamp when the measurement was observed. */
  timestamp: number;
  /** The measurement itself. */
  seconds: number;
  /** The time to first byte the measurement builds on, for the kinds that report one. */
  ttfbSecs?: number | null;
  /** Silence at the head of the first audio, for time to first audio. */
  leadingSilenceSecs?: number | null;
  /**
   * Time between a model's first output and its first answer token, for time
   * to first answer token.
   */
  thinkingTimeSecs?: number | null;
}

/** One measurement of how long a service took. */
export class ServiceLatencyRecord {
  kind: ServiceLatencyKind;
  processor: string;
  model: string | null;
  timestamp: number;
  seconds: number;
  ttfbSecs: number | null;
  leadingSilenceSecs: number | null;
  thinkingTimeSecs: number | null;

  constructor(options: ServiceLatencyRecordOptions) {
    this.kind = options.kind;
    this.processor = options.processor;
    this.model = options.model ?? null;
    this.timestamp = options.timestamp;
    this.seconds = options.seconds;
    this.ttfbSecs = options.ttfbSecs ?? null;
    this.leadingSilenceSecs = options.leadingSilenceSecs ?? null;
    this.thinkingTimeSecs = options.thinkingTimeSecs ?? null;
  }
}

export interface ServiceUsageRecordOptions {
  /** Which kind of service reported. */
  kind: ServiceUsageKind;
  /** Name of the processor that reported it. */
  processor: string;
  /** Model the processor was using, where it names one. */
  model?: string | null;
  /** Unix timestamp when the usage was observed. */
  timestamp: number;
  /** Audio transcribed, for speech-to-text. */
  audioSeconds?: number | null;
  /** Characters synthesised, for text-to-speech. */
  characters?: number | null;
  /** Tokens in the prompt, for an LLM. */
  promptTokens?: number | null;
  /** Tokens generated, for an LLM. */
  completionTokens?: number | null;
  /** Tokens in the prompt and the completion together. */
  totalTokens?: number | null;
  /** Prompt tokens served from cache. */
  cacheReadInputTokens?: number | null;
  /** Prompt tokens written to cache. */
  cacheCreationInputTokens?: number | null;
  /** Tokens spent reasoning before answering. */
  reasoningTokens?: number | null;
  /** Audio tokens in the prompt. */
  inputAudioTokens?: number | null;
  /** Audio tokens generated. */
  outputAudioTokens?: number | null;
  /** Audio prompt tokens served from cache. */
  cacheReadInputAudioTokens?: number | null;
}

/**
 * What one service consumed doing a piece of work.
 *
 * A field is set only where the kind of service reports it, so an LLM record
 * carries token counts and a text-to-speech record carries characters.
 */
export class ServiceUsageRecord {
  kind: ServiceUsageKind;
  processor: string;
  model: string | null;
  timestamp: number;

  audioSeconds: number | null;
  characters: number | null;

  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  reasoningTokens: number | null;
  inputAudioTokens: number | null;
  outputAudioTokens: number | null;
  cacheReadInputAudioTokens: number | null;

  constructor(options: ServiceUsageRecordOptions) {
    this.kind = options.kind;
    this.processor = options.processor;
    this.model = options.model ?? null;
    this.timestamp = options.timestamp;
    this.audioSeconds = options.audioSeconds ?? null;
    this.characters = options.characters ?? null;
    this.promptTokens = options.promptTokens ?? null;
    this.completionTokens = options.completionTokens ?? null;
    this.totalTokens = options.totalTokens ?? null;
    this.cacheReadInputTokens = options.cacheReadInputTokens ?? null;
    this.cacheCreationInputTokens = options.cacheCreationInputTokens ?? null;
    this.reasoningTokens = options.reasoningTokens ?? null;
    this.inputAudioTokens = options.inputAudioTokens ?? null;
    this.outputAudioTokens = options.outputAudioTokens ?? null;
    this.cacheReadInputAudioTokens = options.cacheReadInputAudioTokens ?? null;
  }
}

export interface ServiceMetricsObserverOptions
  extends Omit<BaseObserverOptions, "observeEveryPush"> {
  /**
   * Reads the current time in seconds. Supplying one lets a test place
   * records without waiting. Defaults to `time()`.
   */
  timeSource?: () => number;
}

/**
 * Reports each metric a service publishes as its own record.
 *
 * A record arrives per piece of work rather than per turn or per session: a
 * turn that runs two inferences reports two, and a consumer that wants a
 * total groups them itself. Summing here would lose the grain, and a total
 * held in memory is lost with the process holding it.
 *
 * What a service made someone wait for is here; what it did with its own
 * time is not. Processing time, text aggregation and smart-turn predictions
 * are all deliberately absent: aggregation already appears as a span in
 * `LatencyBreakdown` (see `user_bot_latency_observer`), and the other two
 * describe how work was done rather than what it cost the person waiting.
 *
 * Events:
 *
 * - on_service_latency(observer, record): Emitted for each measurement of a
 *   service's own time, as a `ServiceLatencyRecord`.
 * - on_service_usage(observer, record): Emitted for each report of what a
 *   service consumed, as a `ServiceUsageRecord`.
 *
 * @example
 * const observer = new ServiceMetricsObserver();
 *
 * observer.eventHandler("on_service_usage", async (observer, record: ServiceUsageRecord) => {
 *   logger.info(JSON.stringify(record));
 * });
 */
export class ServiceMetricsObserver extends BaseObserver {
  protected _now: () => number;

  constructor(options: ServiceMetricsObserverOptions = {}) {
    super({ ...options, observeEveryPush: false });
    this._now = options.timeSource ?? time;

    this._registerEventHandler("on_service_latency");
    this._registerEventHandler("on_service_usage");
  }

  /**
   * Report the metrics carried by a frame.
   *
   * Metrics travel in one direction. A frame broadcast both ways would arrive
   * as two frames, and would be reported twice.
   *
   * @param data Frame push event containing the frame and direction.
   */
  override async onPushFrame(data: FramePushed): Promise<void> {
    if (!(data.frame instanceof MetricsFrame)) {
      return;
    }

    for (const metrics of data.frame.data) {
      const latency = this._asLatency(metrics);
      if (latency) {
        await this._callEventHandler("on_service_latency", latency);
        continue;
      }
      const usage = this._asUsage(metrics);
      if (usage) {
        await this._callEventHandler("on_service_usage", usage);
      }
    }
  }

  /**
   * Build a latency record, for the metrics that measure time spent.
   *
   * @param metrics One metric a processor reported.
   * @returns The record, or null if this metric measures something else.
   */
  protected _asLatency(metrics: MetricsData): ServiceLatencyRecord | null {
    const common = {
      processor: metrics.processor,
      model: metrics.model,
      timestamp: this._now(),
    };
    if (metrics instanceof TTFAMetricsData) {
      return new ServiceLatencyRecord({
        kind: ServiceLatencyKind.TTFA,
        seconds: metrics.ttfa,
        ttfbSecs: metrics.ttfb,
        leadingSilenceSecs: metrics.leadingSilence,
        ...common,
      });
    } else if (metrics instanceof TTFATMetricsData) {
      return new ServiceLatencyRecord({
        kind: ServiceLatencyKind.TTFAT,
        seconds: metrics.ttfat,
        ttfbSecs: metrics.ttfb,
        thinkingTimeSecs: metrics.thinkingTime,
        ...common,
      });
    } else if (metrics instanceof TTFBMetricsData) {
      return new ServiceLatencyRecord({
        kind: ServiceLatencyKind.TTFB,
        seconds: metrics.value,
        ...common,
      });
    }
    return null;
  }

  /**
   * Build a usage record, for the metrics that measure what was consumed.
   *
   * @param metrics One metric a processor reported.
   * @returns The record, or null if this metric measures something else.
   */
  protected _asUsage(metrics: MetricsData): ServiceUsageRecord | null {
    const common = {
      processor: metrics.processor,
      model: metrics.model,
      timestamp: this._now(),
    };
    if (metrics instanceof LLMUsageMetricsData) {
      const tokens = metrics.value;
      return new ServiceUsageRecord({
        kind: ServiceUsageKind.LLM,
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
        totalTokens: tokens.totalTokens,
        cacheReadInputTokens: tokens.cacheReadInputTokens,
        cacheCreationInputTokens: tokens.cacheCreationInputTokens,
        reasoningTokens: tokens.reasoningTokens,
        inputAudioTokens: tokens.inputAudioTokens,
        outputAudioTokens: tokens.outputAudioTokens,
        cacheReadInputAudioTokens: tokens.cacheReadInputAudioTokens,
        ...common,
      });
    } else if (metrics instanceof STTUsageMetricsData) {
      return new ServiceUsageRecord({
        kind: ServiceUsageKind.STT,
        audioSeconds: metrics.value.audioSeconds,
        ...common,
      });
    } else if (metrics instanceof TTSUsageMetricsData) {
      return new ServiceUsageRecord({
        kind: ServiceUsageKind.TTS,
        characters: metrics.value,
        ...common,
      });
    }
    return null;
  }
}
