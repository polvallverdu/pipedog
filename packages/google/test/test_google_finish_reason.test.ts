// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_finish_reason.py

/** Tests for finish_reason handling in GoogleLLMService. */

import { expect, test } from "bun:test";

import { FinishReason, GenerateContentResponse, type Part } from "@google/genai";
import {
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LOG_LEVELS, logger } from "@pipedog/core/utils/logger";
import { GoogleLLMService } from "../src/llm.ts";

/** Build a single streamed chunk holding one candidate. */
function _chunk(
  options: { parts?: Part[] | null; finishReason?: FinishReason | null } = {},
): GenerateContentResponse {
  const parts = options.parts ?? null;
  const content = parts !== null ? { role: "model", parts } : undefined;
  const candidate: Record<string, unknown> = {};
  if (content !== undefined) candidate.content = content;
  if (options.finishReason != null) candidate.finishReason = options.finishReason;
  return Object.assign(new GenerateContentResponse(), { candidates: [candidate] });
}

/** Collect warning-level log messages emitted within the block. */
async function _capturedWarnings<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const messages: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) {
      messages.push(record.message);
    }
  });
  try {
    const result = await fn();
    return [result, messages];
  } finally {
    remove();
  }
}

/**
 * Run a context through the service against a canned stream.
 *
 * @returns The pushed frames and any warnings logged while streaming.
 */
async function _stream(...chunks: GenerateContentResponse[]): Promise<[unknown[], string[]]> {
  const service = new GoogleLLMService({ apiKey: "test-key" });
  const frames: unknown[] = [];

  (service as any).pushFrame = async (frame: unknown, _direction?: unknown) => {
    frames.push(frame);
  };

  (service as any)._streamContent = async (_context: LLMContext) => {
    async function* generator() {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    return generator();
  };

  const [, warnings] = await _capturedWarnings(() =>
    (service as any)._processContext(new LLMContext()),
  );

  return [frames, warnings];
}

function texts(frames: unknown[]): string[] {
  return frames.filter((f) => f instanceof LLMTextFrame).map((f) => (f as LLMTextFrame).text);
}

test("test_response_is_bracketed_when_no_text_is_generated", async () => {
  // An empty response still opens and closes, so aggregators aren't left waiting.
  const [frames, warnings] = await _stream(_chunk({ parts: [], finishReason: FinishReason.STOP }));

  expect(frames[0]).toBeInstanceOf(LLMFullResponseStartFrame);
  expect(frames[frames.length - 1]).toBeInstanceOf(LLMFullResponseEndFrame);
  expect(warnings).toEqual([]);
});

test("test_normal_response_logs_no_warning", async () => {
  // A STOP-terminated response with text is passed through untouched.
  const [frames, warnings] = await _stream(
    _chunk({ parts: [{ text: "Hello there." }] }),
    _chunk({ parts: [], finishReason: FinishReason.STOP }),
  );

  expect(texts(frames)).toEqual(["Hello there."]);
  expect(warnings).toEqual([]);
});

test.each([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.RECITATION,
  FinishReason.MALFORMED_FUNCTION_CALL,
  FinishReason.OTHER,
])("test_incomplete_response_logs_the_reason[%s]", async (finishReason) => {
  // A curtailed response names why, rather than ending as a silent empty turn.
  const [frames, warnings] = await _stream(_chunk({ parts: null, finishReason }));

  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain(finishReason);
  expect(frames[frames.length - 1]).toBeInstanceOf(LLMFullResponseEndFrame);
});

test("test_truncated_response_is_passed_through_with_a_warning", async () => {
  // Hitting the output token limit is a warning: the partial text is still usable.
  const [frames, warnings] = await _stream(
    _chunk({ parts: [{ text: "Sure, here's the " }] }),
    _chunk({ parts: [], finishReason: FinishReason.MAX_TOKENS }),
  );

  expect(texts(frames)).toEqual(["Sure, here's the "]);
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("MAX_TOKENS");
});

test("test_chunks_without_finish_reason_log_no_warning", async () => {
  // Intermediate chunks carry no finish reason and must not be reported.
  const [frames, warnings] = await _stream(
    _chunk({ parts: [{ text: "Partial" }] }),
    _chunk({ parts: [{ text: " text." }] }),
  );

  expect(texts(frames)).toEqual(["Partial", " text."]);
  expect(warnings).toEqual([]);
});

/**
 * Run a one-shot inference against a canned, complete response.
 *
 * @returns The returned text and any warnings logged during the call.
 */
async function _runInference(
  options: { parts?: Part[] | null; finishReason?: FinishReason | null } = {},
): Promise<[string | null, string[]]> {
  const service = new GoogleLLMService({ apiKey: "test-key" });

  (service as any)._client.models.generateContent = async (_kwargs: unknown) =>
    _chunk({ parts: options.parts, finishReason: options.finishReason });

  return await _capturedWarnings(() => service.runInference(new LLMContext()));
}

test("test_run_inference_normal_stop_logs_no_warning", async () => {
  // A one-shot reply that ended normally is returned without a warning.
  const [result, warnings] = await _runInference({
    parts: [{ text: "Hello there." }],
    finishReason: FinishReason.STOP,
  });

  expect(result).toBe("Hello there.");
  expect(warnings).toEqual([]);
});

test.each([FinishReason.SAFETY, FinishReason.PROHIBITED_CONTENT])(
  "test_run_inference_withheld_reply_logs_the_reason[%s]",
  async (finishReason) => {
    // A withheld one-shot reply returns None and logs why.
    const [result, warnings] = await _runInference({ parts: null, finishReason });

    expect(result).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(finishReason);
  },
);

test("test_run_inference_truncated_reply_is_returned_with_a_warning", async () => {
  // A reply cut off at the output token limit is still returned, with a warning.
  const [result, warnings] = await _runInference({
    parts: [{ text: "The conversation so far cove" }],
    finishReason: FinishReason.MAX_TOKENS,
  });

  expect(result).toBe("The conversation so far cove");
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("MAX_TOKENS");
});
