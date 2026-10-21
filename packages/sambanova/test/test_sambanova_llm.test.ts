// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_sambanova_llm.py

/**
 * Unit tests for SambaNova LLM service.
 *
 * Porting notes:
 * - `patch.object(SambaNovaLLMService, "create_client")` → `spyOn` on the prototype's
 *   `createClient`, restored after the test.
 * - The JS SDK's stream is closed through `stream.controller.abort()` (Python:
 *   `stream.close()` or the stream's async context manager).
 */

import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { CancelledError } from "@pipedog/asyncio";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { SambaNovaLLMService } from "../src/llm.ts";

let createClientSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  createClientSpy = spyOn(SambaNovaLLMService.prototype, "createClient").mockImplementation(
    () => ({}) as any,
  );
});

afterEach(() => {
  createClientSpy?.mockRestore();
  createClientSpy = null;
});

function asyncMock(impl?: (...args: any[]) => any) {
  return mock(async (...args: any[]) => (impl ? impl(...args) : undefined));
}

test("test_sambanova_llm_stream_closed_on_cancellation", async () => {
  // Test that the stream is closed when CancelledError occurs during iteration.
  //
  // This prevents socket leaks when the pipeline is interrupted (e.g., user
  // interruption). See issue #3639.
  const service: any = new SambaNovaLLMService({
    apiKey: "test-key",
    settings: new SambaNovaLLMService.Settings({ model: "test-model" }),
  });
  service._client = {};

  let streamClosed = false;

  // Mock stream that tracks close calls and raises CancelledError.
  class MockAsyncStream {
    iterationCount = 0;
    controller = {
      abort: () => {
        streamClosed = true;
      },
    };

    [Symbol.asyncIterator]() {
      return this;
    }

    async next(): Promise<IteratorResult<unknown>> {
      this.iterationCount += 1;
      if (this.iterationCount > 1) {
        throw new CancelledError();
      }
      return { done: false, value: { usage: null, choices: [] } };
    }
  }

  const mockStream = new MockAsyncStream();

  service.getChatCompletions = asyncMock(() => mockStream);
  service.startTtfbMetrics = asyncMock();
  service.stopTtfbMetrics = asyncMock();
  service.startLlmUsageMetrics = asyncMock();

  const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

  await expect(service._processContext(context)).rejects.toThrow(CancelledError);

  expect(streamClosed).toBe(true);
});
