// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/metrics/metrics.py

/**
 * Metrics data models for Pipecat framework.
 *
 * Defines models for various types of metrics data collected throughout the
 * pipeline, including timing, token usage, and processing statistics.
 */

export interface MetricsDataOptions {
  /** Name of the processor generating the metrics. */
  processor: string;
  /** Optional model name associated with the metrics. */
  model?: string | null;
}

/**
 * Base class for all metrics data.
 *
 * - `processor`: name of the processor generating the metrics.
 * - `model`: optional model name associated with the metrics.
 */
export class MetricsData {
  processor: string;
  model: string | null;

  constructor(options: MetricsDataOptions) {
    this.processor = options.processor;
    this.model = options.model ?? null;
  }
}

export interface TTFBMetricsDataOptions extends MetricsDataOptions {
  /** TTFB measurement in seconds. */
  value: number;
}

/**
 * Time To First Byte (TTFB) metrics data.
 *
 * - `value`: TTFB measurement in seconds.
 */
export class TTFBMetricsData extends MetricsData {
  value: number;

  constructor(options: TTFBMetricsDataOptions) {
    super(options);
    this.value = options.value;
  }
}

export interface TTFAMetricsDataOptions extends MetricsDataOptions {
  /** TTFA measurement in seconds (`ttfb` plus `leadingSilence`). */
  ttfa: number;
  /** Time-to-first-byte that TTFA builds on, in seconds. */
  ttfb: number;
  /** Silence padding before the first audible sample, in seconds. */
  leadingSilence: number;
}

/**
 * Time To First Audio (TTFA) metrics data.
 *
 * Measures the time from a TTS request to the first audible audio sample,
 * i.e. time-to-first-byte plus any leading silence the service pads onto the
 * start of its response. `ttfa` is reported with its breakdown so consumers
 * can see how much of the perceived latency is silence padding rather than
 * service response time, without correlating a separate `TTFBMetricsData`.
 *
 * - `ttfa`: TTFA measurement in seconds (`ttfb` plus `leadingSilence`).
 * - `ttfb`: time-to-first-byte that TTFA builds on, in seconds. This mirrors
 *   the standalone `TTFBMetricsData` (emitted earlier) for convenience; it is
 *   not a separate measurement, so don't aggregate both.
 * - `leadingSilence`: silence padding before the first audible sample, in
 *   seconds (`ttfa` minus `ttfb`).
 */
export class TTFAMetricsData extends MetricsData {
  ttfa: number;
  ttfb: number;
  leadingSilence: number;

  constructor(options: TTFAMetricsDataOptions) {
    super(options);
    this.ttfa = options.ttfa;
    this.ttfb = options.ttfb;
    this.leadingSilence = options.leadingSilence;
  }
}

export interface TTFATMetricsDataOptions extends MetricsDataOptions {
  /** TTFAT measurement in seconds (`ttfb` plus `thinkingTime`). */
  ttfat: number;
  /** Time-to-first-byte that TTFAT builds on, in seconds. */
  ttfb: number;
  /** Time between the model's first output and the first answer token, in seconds. */
  thinkingTime: number;
}

/**
 * Time To First Answer Token (TTFAT) metrics data.
 *
 * Measures the time from an LLM request to the first token of the answer the
 * caller sees, i.e. time-to-first-byte plus any reasoning the model streamed
 * first. `ttfat` is reported with its breakdown so consumers can see how much
 * of the perceived latency is the model thinking rather than responding,
 * without correlating a separate `TTFBMetricsData`.
 *
 * A turn that answers with a tool call rather than text ends the measurement at
 * the call, taken where it first appears in the stream. Answering from a tool
 * result takes a second inference, so such a turn reports twice — once for the
 * call, once for the answer built from its result. Each figure covers one
 * inference; consumers wanting one per user turn keep the first, which is the
 * one that measures how quickly the model began responding at all.
 *
 * Reported only by LLM services that answer in text. Speech-to-speech services
 * answer in audio, which has no answer token to measure to.
 *
 * - `ttfat`: TTFAT measurement in seconds (`ttfb` plus `thinkingTime`).
 * - `ttfb`: time-to-first-byte that TTFAT builds on, in seconds. This mirrors
 *   the standalone `TTFBMetricsData` (emitted earlier) for convenience; it is
 *   not a separate measurement, so don't aggregate both.
 * - `thinkingTime`: time between the model's first output and the first answer
 *   token, in seconds (`ttfat` minus `ttfb`). Reasoning is the usual reason a
 *   model streams something before it starts answering, though a model that
 *   reasons none still spends a little time here.
 */
export class TTFATMetricsData extends MetricsData {
  ttfat: number;
  ttfb: number;
  thinkingTime: number;

  constructor(options: TTFATMetricsDataOptions) {
    super(options);
    this.ttfat = options.ttfat;
    this.ttfb = options.ttfb;
    this.thinkingTime = options.thinkingTime;
  }
}

export interface ProcessingMetricsDataOptions extends MetricsDataOptions {
  /** Processing time measurement in seconds. */
  value: number;
}

/**
 * General processing time metrics data.
 *
 * - `value`: processing time measurement in seconds.
 */
export class ProcessingMetricsData extends MetricsData {
  value: number;

  constructor(options: ProcessingMetricsDataOptions) {
    super(options);
    this.value = options.value;
  }
}

export interface LLMTokenUsageOptions {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  reasoningTokens?: number | null;
  inputAudioTokens?: number | null;
  outputAudioTokens?: number | null;
  cacheReadInputAudioTokens?: number | null;
}

/**
 * Token usage statistics for LLM operations.
 *
 * Services differ in whether their input count is reported net or gross of the
 * prompt cache. Anthropic and Bedrock report `promptTokens` net, with the
 * cache counts alongside it; OpenAI-compatible services report it gross, with
 * the cache counts already inside it. `totalTokens` is the gross figure
 * either way, so it stays comparable across services, and it is therefore not
 * always `promptTokens + completionTokens`. Read the cache fields for the
 * breakdown rather than subtracting.
 *
 * Per-bucket cost accounting has to account for that difference: adding the
 * cache counts to `promptTokens` double-counts them on a service that
 * reports gross.
 *
 * - `promptTokens`: number of tokens in the input prompt, net or gross of the
 *   cache counts depending on the service. Includes tool results the
 *   provider feeds back to the model, which are billed as input.
 * - `completionTokens`: number of tokens in the generated completion,
 *   including any reasoning tokens.
 * - `totalTokens`: total number of tokens used, including any cached input
 *   tokens.
 * - `cacheReadInputTokens`: number of tokens read from cache, if applicable.
 *   Billed below the input rate.
 * - `cacheCreationInputTokens`: number of tokens written to cache, if
 *   applicable. Billed at or above the input rate.
 * - `reasoningTokens`: number of completion tokens used for reasoning, if applicable.
 * - `inputAudioTokens`: number of prompt tokens that were audio, if applicable.
 * - `outputAudioTokens`: number of completion tokens that were audio, if applicable.
 * - `cacheReadInputAudioTokens`: number of cache-read tokens that were audio, if applicable.
 */
export class LLMTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  reasoningTokens: number | null;
  inputAudioTokens: number | null;
  outputAudioTokens: number | null;
  cacheReadInputAudioTokens: number | null;

  constructor(options: LLMTokenUsageOptions) {
    this.promptTokens = options.promptTokens;
    this.completionTokens = options.completionTokens;
    this.totalTokens = options.totalTokens;
    this.cacheReadInputTokens = options.cacheReadInputTokens ?? null;
    this.cacheCreationInputTokens = options.cacheCreationInputTokens ?? null;
    this.reasoningTokens = options.reasoningTokens ?? null;
    this.inputAudioTokens = options.inputAudioTokens ?? null;
    this.outputAudioTokens = options.outputAudioTokens ?? null;
    this.cacheReadInputAudioTokens = options.cacheReadInputAudioTokens ?? null;
  }
}

export interface LLMUsageMetricsDataOptions extends MetricsDataOptions {
  /** Token usage statistics for the LLM operation. */
  value: LLMTokenUsage;
}

/**
 * LLM token usage metrics data.
 *
 * - `value`: token usage statistics for the LLM operation.
 */
export class LLMUsageMetricsData extends MetricsData {
  value: LLMTokenUsage;

  constructor(options: LLMUsageMetricsDataOptions) {
    super(options);
    this.value = options.value;
  }
}

export interface STTUsageOptions {
  /** Client-measured seconds of audio submitted since the last usage report. */
  audioSeconds: number;
}

/**
 * Usage statistics for STT operations.
 *
 * Reports raw usage, not cost. Values are incremental deltas since the
 * previous usage report; consumers sum them across a session.
 *
 * Continuous STT services stream all input audio (including silence), so
 * their summed `audioSeconds` approximates the stream duration — which
 * is what most streaming providers bill. Segmented STT services submit
 * only the detected speech segments, so their sum covers just those
 * segments.
 *
 * - `audioSeconds`: client-measured seconds of audio submitted to the
 *   service since the last usage report.
 */
export class STTUsage {
  audioSeconds: number;

  constructor(options: STTUsageOptions) {
    this.audioSeconds = options.audioSeconds;
  }
}

export interface STTUsageMetricsDataOptions extends MetricsDataOptions {
  /** Usage statistics for the STT operation. */
  value: STTUsage;
}

/**
 * Speech-to-Text usage metrics data.
 *
 * - `value`: usage statistics for the STT operation.
 */
export class STTUsageMetricsData extends MetricsData {
  value: STTUsage;

  constructor(options: STTUsageMetricsDataOptions) {
    super(options);
    this.value = options.value;
  }
}

export interface TTSUsageMetricsDataOptions extends MetricsDataOptions {
  /** Number of characters processed by TTS. */
  value: number;
}

/**
 * Text-to-Speech usage metrics data.
 *
 * - `value`: number of characters processed by TTS.
 */
export class TTSUsageMetricsData extends MetricsData {
  value: number;

  constructor(options: TTSUsageMetricsDataOptions) {
    super(options);
    this.value = options.value;
  }
}

export interface TextAggregationMetricsDataOptions extends MetricsDataOptions {
  /** Aggregation time in seconds. */
  value: number;
}

/**
 * Text aggregation time metrics data.
 *
 * Measures the time from the first LLM token to the first complete sentence,
 * representing the latency cost of sentence aggregation in the TTS pipeline.
 *
 * - `value`: aggregation time in seconds.
 */
export class TextAggregationMetricsData extends MetricsData {
  value: number;

  constructor(options: TextAggregationMetricsDataOptions) {
    super(options);
    this.value = options.value;
  }
}

export interface TurnMetricsDataOptions extends MetricsDataOptions {
  /** Whether the turn is predicted to be complete. */
  isComplete: boolean;
  /** Confidence probability of the turn completion prediction. */
  probability: number;
  /** End-to-end processing time in milliseconds. */
  e2eProcessingTimeMs: number;
}

/**
 * Metrics data for turn detection predictions.
 *
 * - `isComplete`: whether the turn is predicted to be complete.
 * - `probability`: confidence probability of the turn completion prediction.
 * - `e2eProcessingTimeMs`: end-to-end processing time in milliseconds,
 *   measured from VAD speech-to-silence transition to turn completion.
 */
export class TurnMetricsData extends MetricsData {
  isComplete: boolean;
  probability: number;
  e2eProcessingTimeMs: number;

  constructor(options: TurnMetricsDataOptions) {
    super(options);
    this.isComplete = options.isComplete;
    this.probability = options.probability;
    this.e2eProcessingTimeMs = options.e2eProcessingTimeMs;
  }
}
