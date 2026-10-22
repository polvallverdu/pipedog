// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/whisper/utils.py

/**
 * Utility functions for extracting probability metrics from STT services.
 *
 * Porting notes: upstream reads attributes off the provider SDKs' response
 * objects (`frame.result.segments[0].avg_logprob`). The pipedog services put
 * the provider's JSON in `TranscriptionFrame.result` as a plain object (the
 * `openai` SDK's `Transcription` / `TranscriptionVerbose` for OpenAI and Groq,
 * Deepgram's `Results` message), so these read the same fields from it.
 */

import type { TranscriptionFrame } from "@pipedog/core/frames/frames";

type Dict = Record<string, unknown>;

function isObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null;
}

/** Python truthiness for the values these helpers test. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  // The results are dicts here, and an empty dict is falsy.
  if (isObject(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length > 0;
  }
  return true;
}

/**
 * Extract probability from Whisper-based TranscriptionFrame result.
 *
 * Works with Groq, OpenAI Whisper, or other Whisper-based services that use
 * verbose_json format with segments containing avg_logprob.
 *
 * Converts avg_logprob to probability.
 *
 * @param frame TranscriptionFrame with result from GroqSTTService or
 *   OpenAISTTService (when includeProbMetrics=true and using Whisper models).
 * @returns Probability (0-1) if available, null otherwise.
 *
 * @example
 * ```ts
 * import { GroqSTTService } from "@pipedog/groq/stt";
 * import { extractWhisperProbability } from "@pipedog/whisper/utils";
 *
 * const stt = new GroqSTTService({ apiKey: process.env.GROQ_API_KEY!, includeProbMetrics: true });
 * // ... use stt in pipeline ...
 * // In your frame processor:
 * if (frame instanceof TranscriptionFrame) {
 *   const prob = extractWhisperProbability(frame);
 *   if (prob) console.log(`Transcription confidence: ${(prob * 100).toFixed(2)}%`);
 * }
 * ```
 */
export function extractWhisperProbability(frame: TranscriptionFrame): number | null {
  const result = frame.result;
  if (!truthy(result) || !isObject(result)) {
    return null;
  }

  // Whisper verbose_json format: response.segments[0].avg_logprob
  const segments = result.segments;
  if (Array.isArray(segments) && segments.length > 0) {
    const segment = segments[0];
    const avgLogprob = isObject(segment) ? segment.avg_logprob : undefined;
    if (typeof avgLogprob === "number") {
      return Math.exp(avgLogprob);
    }
  }

  return null;
}

/**
 * Extract probability from OpenAI GPT-4o-transcribe TranscriptionFrame result.
 *
 * DIVERGENCE: upstream sums `response.logprobs` directly, but the OpenAI API
 * returns them as `{token, logprob, bytes}` objects (which upstream's `sum()`
 * can't add). This reads each entry's `logprob` (plain numbers are accepted too).
 *
 * @param frame TranscriptionFrame with result from OpenAISTTService using a
 *   GPT transcription model (when includeProbMetrics=true).
 * @returns Probability (0-1) if available, null otherwise.
 *
 * @example
 * ```ts
 * import { OpenAISTTService } from "@pipedog/openai/stt";
 * import { extractOpenaiGpt4oProbability } from "@pipedog/whisper/utils";
 *
 * const stt = new OpenAISTTService({ includeProbMetrics: true });
 * // In your frame processor:
 * if (frame instanceof TranscriptionFrame) {
 *   const prob = extractOpenaiGpt4oProbability(frame);
 *   if (prob) console.log(`Transcription confidence: ${(prob * 100).toFixed(2)}%`);
 * }
 * ```
 */
export function extractOpenaiGpt4oProbability(frame: TranscriptionFrame): number | null {
  const result = frame.result;
  if (!truthy(result) || !isObject(result)) {
    return null;
  }

  // OpenAI GPT transcription format: response.logprobs
  if ("logprobs" in result) {
    const logprobs = result.logprobs;
    if (Array.isArray(logprobs) && logprobs.length > 0) {
      const values = logprobs.map((lp) => (isObject(lp) ? lp.logprob : lp));
      if (values.every((v): v is number => typeof v === "number")) {
        // Calculate average logprob and convert to probability
        const avgLogprob = values.reduce((a, b) => a + b, 0) / values.length;
        return Math.exp(avgLogprob);
      }
    }
  }

  return null;
}

/**
 * Extract probability from Deepgram TranscriptionFrame result.
 *
 * @param frame TranscriptionFrame with result from DeepgramSTTService.
 * @returns Probability (0-1) if available, null otherwise. Returns
 *   alternative-level confidence if available, otherwise calculates average
 *   confidence from word-level confidences.
 *
 * @example
 * ```ts
 * import { DeepgramSTTService } from "@pipedog/deepgram/stt";
 * import { extractDeepgramProbability } from "@pipedog/whisper/utils";
 *
 * const stt = new DeepgramSTTService({ apiKey: process.env.DEEPGRAM_API_KEY! });
 * // In your frame processor:
 * if (frame instanceof TranscriptionFrame) {
 *   const prob = extractDeepgramProbability(frame);
 *   if (prob) console.log(`Transcription confidence: ${(prob * 100).toFixed(2)}%`);
 * }
 * ```
 */
export function extractDeepgramProbability(frame: TranscriptionFrame): number | null {
  const result = frame.result;
  if (!truthy(result) || !isObject(result)) {
    return null;
  }

  const channel = result.channel;
  if (truthy(channel) && isObject(channel)) {
    const alternatives = channel.alternatives;
    if (Array.isArray(alternatives) && alternatives.length > 0) {
      const alt = alternatives[0];
      if (!isObject(alt)) return null;
      const conf = alt.confidence;
      if (conf !== null && conf !== undefined) {
        return Number(conf);
      }

      const words = alt.words;
      if (Array.isArray(words) && words.length > 0) {
        const wordConfs = words
          .map((w) => (isObject(w) ? w.confidence : undefined))
          .filter((c): c is number => c !== null && c !== undefined)
          .map(Number);
        if (wordConfs.length > 0) {
          return wordConfs.reduce((a, b) => a + b, 0) / wordConfs.length;
        }
      }
    }
  }

  return null;
}
