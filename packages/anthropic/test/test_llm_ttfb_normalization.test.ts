// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_ttfb_normalization.py

/**
 * Tests that LLM services end TTFB at the model's first output.
 *
 * TTFB is comparable across services only when they all stop it on the same thing:
 * the first output the model produces, rather than an earlier event that merely
 * acknowledges the request. These tests pin that boundary for the services whose
 * streams open with such an event.
 *
 * PORTING NOTES:
 * - `patch.object(service, name, fake)` → the fake is assigned on the instance
 *   and the original restored afterwards.
 * - Google chunks are built as plain objects with the JS SDK's camelCase
 *   field names (`candidates`, `usageMetadata`, `promptTokenCount`) instead of
 *   the google-genai pydantic models; the service only reads those fields.
 * - `GoogleLLMService` is imported by relative path from `@pipedog/google`,
 *   which this package does not depend on.
 */

import { describe, expect, test } from "bun:test";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { GoogleLLMService } from "../../google/src/llm.ts";
import { AnthropicLLMService } from "../src/llm.ts";

type Internals = any;
type PatchStream = (service: Internals, generator: () => AsyncGenerator<unknown>) => () => void;

/** Assign `value` to `obj[name]`, returning a function that restores it. */
function patchObject(obj: Internals, name: string, value: unknown): () => void {
  const had = Object.hasOwn(obj, name);
  const original = obj[name];
  obj[name] = value;
  return () => {
    if (had) {
      obj[name] = original;
    } else {
      delete obj[name];
    }
  };
}

/**
 * Stream canned chunks and report which one ended TTFB.
 *
 * @returns Index of the chunk being processed when TTFB stopped, or null if it
 *   never stopped.
 */
async function _stopIndex(
  service: Internals,
  patchStream: PatchStream,
  chunks: unknown[],
): Promise<number | null> {
  const state: { index: number; stoppedAt: number | null } = { index: -1, stoppedAt: null };

  async function fakeStopTtfb(..._args: unknown[]): Promise<void> {
    if (state.stoppedAt === null) {
      state.stoppedAt = state.index;
    }
  }

  async function* generator(): AsyncGenerator<unknown> {
    for (const [index, chunk] of chunks.entries()) {
      state.index = index;
      yield chunk;
    }
  }

  async function captureFrame(_frame: unknown, _direction?: unknown): Promise<void> {}

  const restores = [
    patchObject(service, "pushFrame", captureFrame),
    patchObject(service, "stopTtfbMetrics", fakeStopTtfb),
    patchStream(service, generator),
  ];
  try {
    await service._processContext(new LLMContext());
  } finally {
    for (const restore of restores.reverse()) {
      restore();
    }
  }

  return state.stoppedAt;
}

// -- Google -----------------------------------------------------------------

/** Patch GoogleLLMService's stream with a canned chunk generator. */
function _googlePatchStream(
  service: Internals,
  generator: () => AsyncGenerator<unknown>,
): () => void {
  async function fakeStream(_context: unknown, ..._rest: unknown[]) {
    return generator();
  }

  return patchObject(service, "_streamContent", fakeStream);
}

/** A chunk carrying only usage metadata, with no candidates. */
function _googleUsageChunk(): Record<string, unknown> {
  return {
    candidates: undefined,
    usageMetadata: { promptTokenCount: 10 },
  };
}

/** A chunk carrying model output. */
function _googleTextChunk(text: string): Record<string, unknown> {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
  };
}

describe("test_llm_ttfb_normalization", () => {
  test("test_google_usage_only_chunk_does_not_stop_ttfb", async () => {
    const service = new GoogleLLMService({ apiKey: "test-key" });
    const stoppedAt = await _stopIndex(service, _googlePatchStream, [
      _googleUsageChunk(),
      _googleTextChunk("Hello"),
    ]);
    expect(stoppedAt).toBe(1);
  });

  test("test_google_stops_ttfb_on_first_output_chunk", async () => {
    const service = new GoogleLLMService({ apiKey: "test-key" });
    const stoppedAt = await _stopIndex(service, _googlePatchStream, [_googleTextChunk("Hello")]);
    expect(stoppedAt).toBe(0);
  });

  // -- Anthropic --------------------------------------------------------------

  test("test_anthropic_message_start_does_not_stop_ttfb", async () => {
    const service = new AnthropicLLMService({ apiKey: "test-key" });
    const stoppedAt = await _stopIndex(service, _anthropicPatchStream, [
      _messageStart(),
      _contentBlockStart("text"),
      _textDelta("Hello"),
    ]);
    expect(stoppedAt).toBe(1);
  });

  /** Reasoning is output, so it ends TTFB just as answer text would. */
  test("test_anthropic_stops_ttfb_on_thinking_before_any_answer_text", async () => {
    const service = new AnthropicLLMService({ apiKey: "test-key" });
    const stoppedAt = await _stopIndex(service, _anthropicPatchStream, [
      _messageStart(),
      _contentBlockStart("thinking"),
      _thinkingDelta("Considering..."),
      _contentBlockStart("text"),
      _textDelta("Hello"),
    ]);
    expect(stoppedAt).toBe(1);
  });
});

/** Patch AnthropicLLMService's stream with a canned event generator. */
function _anthropicPatchStream(
  service: Internals,
  generator: () => AsyncGenerator<unknown>,
): () => void {
  async function fakeStream(_apiCall: unknown, _params: unknown) {
    return generator();
  }

  return patchObject(service, "_createMessageStream", fakeStream);
}

/** The event opening an Anthropic stream, which carries no model output. */
function _messageStart(): Record<string, unknown> {
  return { type: "message_start", message: { usage: null } };
}

function _contentBlockStart(blockType: string): Record<string, unknown> {
  return { type: "content_block_start", content_block: { type: blockType } };
}

function _textDelta(text: string): Record<string, unknown> {
  return { type: "content_block_delta", delta: { text } };
}

function _thinkingDelta(thinking: string): Record<string, unknown> {
  return { type: "content_block_delta", delta: { thinking } };
}
