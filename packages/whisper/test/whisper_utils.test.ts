// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Tests for `utils.ts` (upstream has none), with `result` shaped as the
 * pipedog services set it: the OpenAI / Groq `audio/transcriptions` JSON and
 * Deepgram's `Results` message.
 */

import { describe, expect, test } from "bun:test";
import { TranscriptionFrame } from "@pipedog/core/frames/frames";
import {
  extractDeepgramProbability,
  extractOpenaiGpt4oProbability,
  extractWhisperProbability,
} from "../src/utils.ts";

function frame(result: unknown): TranscriptionFrame {
  return new TranscriptionFrame({ text: "hi", userId: "u", timestamp: "t", result });
}

describe("extractWhisperProbability", () => {
  test("reads segments[0].avg_logprob of a verbose_json response", () => {
    const result = {
      task: "transcribe",
      language: "english",
      duration: 1.2,
      text: "hi",
      segments: [
        { id: 0, avg_logprob: -0.25, no_speech_prob: 0.01, text: "hi" },
        { id: 1, avg_logprob: -3, text: "" },
      ],
    };
    expect(extractWhisperProbability(frame(result))).toBeCloseTo(Math.exp(-0.25), 12);
  });

  test("null without segments or result", () => {
    expect(extractWhisperProbability(frame({ text: "hi" }))).toBeNull();
    expect(extractWhisperProbability(frame({ text: "hi", segments: [] }))).toBeNull();
    expect(extractWhisperProbability(frame({ segments: [{ text: "x" }] }))).toBeNull();
    expect(extractWhisperProbability(frame(null))).toBeNull();
    expect(extractWhisperProbability(frame({}))).toBeNull();
  });
});

describe("extractOpenaiGpt4oProbability", () => {
  test("averages the logprob of each token", () => {
    const result = {
      text: "hi there",
      logprobs: [
        { token: "hi", logprob: -0.1, bytes: [104, 105] },
        { token: " there", logprob: -0.3, bytes: [32] },
      ],
    };
    expect(extractOpenaiGpt4oProbability(frame(result))).toBeCloseTo(Math.exp(-0.2), 12);
  });

  test("accepts plain numbers, as upstream sums them", () => {
    expect(extractOpenaiGpt4oProbability(frame({ logprobs: [-1, -3] }))).toBeCloseTo(
      Math.exp(-2),
      12,
    );
  });

  test("null without logprobs", () => {
    expect(extractOpenaiGpt4oProbability(frame({ text: "hi" }))).toBeNull();
    expect(extractOpenaiGpt4oProbability(frame({ text: "hi", logprobs: [] }))).toBeNull();
    expect(extractOpenaiGpt4oProbability(frame({ text: "hi", logprobs: null }))).toBeNull();
    expect(extractOpenaiGpt4oProbability(frame(null))).toBeNull();
  });
});

describe("extractDeepgramProbability", () => {
  const message = (alternative: Record<string, unknown>) => ({
    type: "Results",
    is_final: true,
    channel: { alternatives: [alternative] },
  });

  test("prefers the alternative's confidence", () => {
    const result = message({
      transcript: "hello",
      confidence: 0.92,
      words: [{ word: "hello", confidence: 0.5 }],
    });
    expect(extractDeepgramProbability(frame(result))).toBe(0.92);
  });

  test("a zero confidence is still a confidence", () => {
    expect(extractDeepgramProbability(frame(message({ confidence: 0 })))).toBe(0);
  });

  test("falls back to the mean word confidence", () => {
    const result = message({
      transcript: "hello world",
      words: [
        { word: "hello", confidence: 0.8 },
        { word: "world", confidence: 0.6 },
        { word: "?" },
      ],
    });
    expect(extractDeepgramProbability(frame(result))).toBeCloseTo(0.7, 12);
  });

  test("null without alternatives", () => {
    expect(extractDeepgramProbability(frame({ channel: { alternatives: [] } }))).toBeNull();
    expect(extractDeepgramProbability(frame(message({ words: [] })))).toBeNull();
    expect(extractDeepgramProbability(frame({ type: "Metadata" }))).toBeNull();
    expect(extractDeepgramProbability(frame(null))).toBeNull();
  });
});
