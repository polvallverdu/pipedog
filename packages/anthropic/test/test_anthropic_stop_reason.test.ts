// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_anthropic_stop_reason.py

/** Tests for stop_reason handling in AnthropicLLMService. */

import { expect, test } from "bun:test";
import {
  type Frame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LOG_LEVELS, logger } from "@pipedog/core/utils/logger";
import { AnthropicLLMService } from "../src/llm.ts";

function _usage() {
  return {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    output_tokens_details: null,
  };
}

/** Build a streamed text delta. */
function _text(text: string) {
  return { type: "content_block_delta", delta: { text } };
}

/** Build the message_delta event that ends a stream. */
function _stop(stopReason: string | null, category: string | null = null) {
  const details = category ? { type: "refusal", category } : null;
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_details: details },
    usage: _usage(),
  };
}

/** Collect warning-level log messages emitted within the block. */
async function _capturedWarnings<T>(
  fn: (messages: string[]) => Promise<T>,
): Promise<[T, string[]]> {
  const messages: string[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.WARNING) messages.push(record.message);
  });
  try {
    return [await fn(messages), messages];
  } finally {
    remove();
  }
}

function _newService(): AnthropicLLMService {
  return new AnthropicLLMService({
    apiKey: "test-key",
    settings: new AnthropicLLMService.Settings({ model: "claude-sonnet-5-5" }),
  });
}

/**
 * Run a context through the service against a canned stream.
 *
 * @returns The pushed frames and any warnings logged while streaming.
 */
async function _stream(...events: unknown[]): Promise<[Frame[], string[]]> {
  const service = _newService() as any;
  const frames: Frame[] = [];

  service.pushFrame = async (frame: Frame, _direction?: unknown) => {
    frames.push(frame);
  };
  service._createMessageStream = async (_apiCall: unknown, _params: unknown) => {
    async function* generator() {
      for (const event of events) {
        yield event;
      }
    }
    return generator();
  };

  const [, warnings] = await _capturedWarnings(() => service._processContext(new LLMContext()));
  return [frames, warnings];
}

for (const stopReason of ["end_turn", "tool_use", "stop_sequence"]) {
  test(`test_normal_stop_logs_no_warning[${stopReason}]`, async () => {
    // A response that ended the way the model meant it to is passed through untouched.
    const [frames, warnings] = await _stream(_text("Hello there."), _stop(stopReason));

    expect(
      frames.filter((f) => f instanceof LLMTextFrame).map((f) => (f as LLMTextFrame).text),
    ).toEqual(["Hello there."]);
    expect(warnings).toEqual([]);
  });
}

test("test_refusal_logs_the_reason_and_category", async () => {
  // A refused turn names why, rather than ending as a silent empty turn.
  const [frames, warnings] = await _stream(_stop("refusal", "reasoning_extraction"));

  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("refusal (reasoning_extraction)");
  expect(frames[0]).toBeInstanceOf(LLMFullResponseStartFrame);
  expect(frames[frames.length - 1]).toBeInstanceOf(LLMFullResponseEndFrame);
});

test("test_refusal_without_a_category_logs_the_reason", async () => {
  // Anthropic leaves the category out of a refusal that maps to no named one.
  const [, warnings] = await _stream(_stop("refusal"));

  expect(warnings.length).toBe(1);
  expect(warnings[0]!.endsWith("refusal")).toBe(true);
});

for (const stopReason of [
  "max_tokens",
  "model_context_window_exceeded",
  "pause_turn",
  "a_new_reason",
]) {
  test(`test_truncated_response_is_passed_through_with_a_warning[${stopReason}]`, async () => {
    // A curtailed response is a warning: the partial text is still usable.
    const [frames, warnings] = await _stream(_text("Sure, here's the "), _stop(stopReason));

    expect(
      frames.filter((f) => f instanceof LLMTextFrame).map((f) => (f as LLMTextFrame).text),
    ).toEqual(["Sure, here's the "]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(stopReason);
  });
}

test("test_message_delta_without_stop_reason_logs_no_warning", async () => {
  // A message_delta that only carries usage must not be reported.
  const [, warnings] = await _stream(_text("Partial"), _stop(null));

  expect(warnings).toEqual([]);
});

/**
 * Run a one-shot inference against a canned, complete message.
 *
 * @returns The returned text and any warnings logged during the call.
 */
async function _runInference(
  text: string | null,
  stopReason: string,
  category: string | null = null,
): Promise<[string | null, string[]]> {
  const service = _newService() as any;
  const details = category ? { type: "refusal", category } : null;
  const content = text !== null ? [{ type: "text", text }] : [];
  const message = { content, stop_reason: stopReason, stop_details: details };

  service._client.beta.messages.create = async (_params: unknown, _options?: unknown) => message;

  return await _capturedWarnings(() => service.runInference(new LLMContext()));
}

for (const stopReason of ["end_turn", "tool_use", "stop_sequence"]) {
  test(`test_run_inference_normal_stop_logs_no_warning[${stopReason}]`, async () => {
    // A one-shot reply that ended normally is returned without a warning.
    const [result, warnings] = await _runInference("Hello there.", stopReason);

    expect(result).toBe("Hello there.");
    expect(warnings).toEqual([]);
  });
}

test("test_run_inference_refusal_logs_the_reason_and_category", async () => {
  // A refused one-shot inference returns null and logs why.
  const [result, warnings] = await _runInference(null, "refusal", "reasoning_extraction");

  expect(result).toBeNull();
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("refusal (reasoning_extraction)");
});

test("test_run_inference_truncated_reply_is_returned_with_a_warning", async () => {
  // A reply cut off at max_tokens is still returned, with a warning naming the cause.
  const [result, warnings] = await _runInference("The conversation so far cove", "max_tokens");

  expect(result).toBe("The conversation so far cove");
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("max_tokens");
});
