// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_llm_timeout.py

/**
 * Unit tests for OpenAI LLM error handling.
 *
 * Porting notes:
 * - `patch.object(OpenAILLMService, "create_client")` → `spyOn` on the
 *   prototype's `createClient`, restored after each test.
 * - `tests.openai_http_helpers.http` (the httpx family) has no JS counterpart:
 *   `http.TimeoutException` is the asyncio `TimeoutError` (what
 *   `TIMEOUT_EXCEPTIONS` lists), and SDK errors are built with `Headers`.
 * - The JS SDK's stream is closed through `stream.controller.abort()`, and its
 *   async iterator through `iterator.return()` (Python: `stream.close()` /
 *   `iterator.aclose()`).
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CancelledError, TimeoutError } from "@pipedog/asyncio";
import { LLMContextConversionError } from "@pipedog/core/adapters/llm/base_llm_adapter";
import {
  type Frame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { TIMEOUT_EXCEPTIONS } from "@pipedog/core/utils/http";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  RateLimitError,
  UnprocessableEntityError,
} from "openai";
import { OpenAILLMService } from "../src/llm.ts";

/** Build a real OpenAI API status error of the given HTTP status. */
function _openaiStatusError(statusCode: number): APIError {
  const classes: Record<number, new (...args: any[]) => APIError> = {
    400: BadRequestError,
    422: UnprocessableEntityError,
    429: RateLimitError,
  };
  const cls = classes[statusCode] ?? APIError;
  return new cls(statusCode, { error: {} }, "simulated api error", new Headers());
}

let createClientSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  // patch.object(OpenAILLMService, "create_client")
  createClientSpy = spyOn(OpenAILLMService.prototype, "createClient").mockImplementation(
    () => ({}) as any,
  );
});

afterEach(() => {
  createClientSpy?.mockRestore();
  createClientSpy = null;
});

function newService(): any {
  const service: any = new OpenAILLMService({
    settings: new OpenAILLMService.Settings({ model: "gpt-4" }),
  });
  service._client = {};
  return service;
}

function asyncMock(impl?: (...args: any[]) => any) {
  return mock(async (...args: any[]) => (impl ? impl(...args) : undefined));
}

function rejecting(error: unknown) {
  return mock(async (..._args: any[]) => {
    throw error;
  });
}

async function addPdf(context: LLMContext, file = "data:application/pdf;base64,ZmFrZSBwZGY=") {
  await context.addFileFrameMessage({ type: "bytes", format: "application/pdf", file });
}

describe.each(TIMEOUT_EXCEPTIONS.map((e) => [e.name, e] as const))(
  "test_openai_llm_emits_error_frame_on_timeout[%s]",
  (_id, timeoutException) => {
    test("test_openai_llm_emits_error_frame_on_timeout", async () => {
      // Test that OpenAI LLM service emits ErrorFrame when a timeout occurs.
      //
      // This enables LLMSwitcher to trigger failover to backup LLMs when the
      // primary LLM times out.
      const service = newService();

      // Track pushed frames and errors
      const pushedFrames: Frame[] = [];
      const pushedErrors: { errorMsg: string; exception: unknown }[] = [];
      let timeoutHandlerCalled = false;

      const originalPushFrame = service.pushFrame.bind(service);

      service.pushFrame = async (
        frame: Frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
      ) => {
        pushedFrames.push(frame);
        await originalPushFrame(frame, direction);
      };

      service.pushError = async (errorMsg: string, options: { exception?: unknown } = {}) => {
        pushedErrors.push({ errorMsg, exception: options.exception ?? null });
      };

      service._callEventHandler = asyncMock((eventName: string) => {
        if (eventName === "on_completion_timeout") {
          timeoutHandlerCalled = true;
        }
      });

      // Mock _processContext to raise TimeoutException
      const TimeoutCls = timeoutException as unknown as new (msg: string) => Error;
      service._processContext = rejecting(new TimeoutCls("Connection timed out"));

      // Mock metrics methods
      service.startProcessingMetrics = asyncMock();
      service.stopProcessingMetrics = asyncMock();
      service.startTtfbMetrics = asyncMock();

      // Create a context frame to process
      const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });
      const frame = new LLMContextFrame({ context });

      // Process the frame
      await service.processFrame(frame, FrameDirection.DOWNSTREAM);

      // Verify timeout handler was called
      expect(service._callEventHandler).toHaveBeenCalledWith("on_completion_timeout");
      expect(timeoutHandlerCalled).toBe(true);

      // Verify pushError was called with correct message
      expect(pushedErrors.length).toBe(1);
      expect(pushedErrors[0]!.errorMsg).toBe("LLM completion timeout");
      expect(pushedErrors[0]!.exception).toBeInstanceOf(TimeoutCls);

      // Verify LLMFullResponseStartFrame and LLMFullResponseEndFrame were pushed
      const frameTypes = pushedFrames.map((f) => f.constructor);
      expect(frameTypes).toContain(LLMFullResponseStartFrame);
      expect(frameTypes).toContain(LLMFullResponseEndFrame);
    });
  },
);

test("test_openai_llm_timeout_still_pushes_end_frame", async () => {
  // Test that LLMFullResponseEndFrame is pushed even when timeout occurs.
  //
  // The finally block should ensure proper cleanup regardless of timeout.
  const service = newService();

  const pushedFrames: Frame[] = [];

  service.pushFrame = async (frame: Frame, _direction = FrameDirection.DOWNSTREAM) => {
    pushedFrames.push(frame);
  };
  service.pushError = asyncMock();
  service._callEventHandler = asyncMock();
  service._processContext = rejecting(new TimeoutError("Timeout"));
  service.startProcessingMetrics = asyncMock();
  service.stopProcessingMetrics = asyncMock();

  const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });
  const frame = new LLMContextFrame({ context });

  await service.processFrame(frame, FrameDirection.DOWNSTREAM);

  // Verify both start and end frames are pushed
  const frameTypes = pushedFrames.map((f) => f.constructor);
  expect(frameTypes).toContain(LLMFullResponseStartFrame);
  expect(frameTypes).toContain(LLMFullResponseEndFrame);

  // Verify metrics were stopped
  expect(service.stopProcessingMetrics).toHaveBeenCalledTimes(1);
});

test("test_openai_llm_stream_closed_on_cancellation", async () => {
  // Test that the stream is closed when CancelledError occurs during iteration.
  //
  // This prevents socket leaks when the pipeline is interrupted (e.g., user
  // interruption). See issue #3589.
  const service = newService();

  // Track if close was called
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
        // Simulate cancellation during iteration
        throw new CancelledError();
      }
      // Return a minimal chunk for first iteration
      return { done: false, value: { usage: null, model: null, choices: [] } };
    }
  }

  const mockStream = new MockAsyncStream();

  // Mock the stream creation methods
  service.getChatCompletions = asyncMock(() => mockStream);
  service.startTtfbMetrics = asyncMock();
  service.stopTtfbMetrics = asyncMock();
  service.startLlmUsageMetrics = asyncMock();

  const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

  // Process context should raise CancelledError but stream should still be closed
  await expect(service._processContext(context)).rejects.toThrow(CancelledError);

  // Verify stream was closed despite the cancellation
  expect(streamClosed).toBe(true);
});

test("test_openai_llm_emits_error_frame_on_exception", async () => {
  // Test that OpenAI LLM service emits ErrorFrame when a general exception occurs.
  //
  // This enables proper error handling for API errors, rate limits, and other failures.
  const service = newService();

  const pushedErrors: { errorMsg: string; exception: unknown }[] = [];

  service.pushFrame = asyncMock();
  service.pushError = async (errorMsg: string, options: { exception?: unknown } = {}) => {
    pushedErrors.push({ errorMsg, exception: options.exception ?? null });
  };
  service._callEventHandler = asyncMock();
  service._processContext = rejecting(new Error("API Error"));
  service.startProcessingMetrics = asyncMock();
  service.stopProcessingMetrics = asyncMock();

  const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });
  const frame = new LLMContextFrame({ context });

  await service.processFrame(frame, FrameDirection.DOWNSTREAM);

  // Verify pushError was called with correct message
  expect(pushedErrors.length).toBe(1);
  expect(pushedErrors[0]!.errorMsg).toContain("Error during completion");
  expect(pushedErrors[0]!.errorMsg).toContain("API Error");
  expect(pushedErrors[0]!.exception).toBeInstanceOf(Error);
});

test("test_openai_llm_removes_file_message_on_context_conversion_error", async () => {
  // Test that an LLMContextConversionError also triggers file-message cleanup.
  //
  // An unsupported file MIME type (or corrupt base64) fails during local
  // message conversion, before any request reaches OpenAI at all — so it
  // never surfaces as an invalid_request_error, but it's just as much
  // evidence the file was the problem.
  const service = newService();

  service.pushFrame = asyncMock();
  service.pushError = asyncMock();

  service._processContext = rejecting(
    new LLMContextConversionError(new Error("Unsupported 'file' MIME type")),
  );
  service.startProcessingMetrics = asyncMock();
  service.stopProcessingMetrics = asyncMock();

  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });
  await addPdf(context);
  const frame = new LLMContextFrame({ context });

  await service.processFrame(frame, FrameDirection.DOWNSTREAM);

  const messages = context.getMessages() as any[];
  expect(messages.length).toBe(1);
  expect(messages[0].content).toBe("hello");
});

test("test_openai_llm_removes_file_message_on_bad_request_error", async () => {
  // Test that a payload-shaped API error (400) triggers file-message cleanup.
  //
  // OpenAI receives files inline (file_data), so a rejected file surfaces as a
  // BadRequestError rather than anything file-specific. Cleanup prevents the
  // context from getting permanently stuck retrying a file OpenAI has already
  // rejected.
  const service = newService();

  service.pushFrame = asyncMock();
  service.pushError = asyncMock();

  service._processContext = rejecting(_openaiStatusError(400));
  service.startProcessingMetrics = asyncMock();
  service.stopProcessingMetrics = asyncMock();

  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });
  await addPdf(context);
  const frame = new LLMContextFrame({ context });

  await service.processFrame(frame, FrameDirection.DOWNSTREAM);

  const messages = context.getMessages() as any[];
  expect(messages.length).toBe(1);
  expect(messages[0].content).toBe("hello");
});

test("test_openai_llm_removes_file_message_despite_newer_message", async () => {
  // Test that the right file message is found even if it's no longer the newest.
  //
  // A file arriving alongside a separately-aggregated user utterance (e.g. the
  // user was mid-turn when the file was sent) can end up with a plain-text
  // message added after it, before either has gone through a completion. The
  // file should still be identified as the removal candidate.
  const service = newService();

  service.pushFrame = asyncMock();
  service.pushError = asyncMock();

  service._processContext = rejecting(_openaiStatusError(400));
  service.startProcessingMetrics = asyncMock();
  service.stopProcessingMetrics = asyncMock();

  const context = new LLMContext();
  await addPdf(context);
  context.addMessage({ role: "user", content: "what does it say?" });
  const frame = new LLMContextFrame({ context });

  await service.processFrame(frame, FrameDirection.DOWNSTREAM);

  const messages = context.getMessages() as any[];
  expect(messages.length).toBe(1);
  expect(messages[0].content).toBe("what does it say?");
});

test("test_openai_llm_leaves_a_confirmed_file_message_alone", async () => {
  // Test that a file already confirmed accepted by a prior completion is untouched.
  //
  // Once an assistant reply has followed the file, it's no longer a removal
  // candidate — a later, unrelated turn erroring out shouldn't discard it.
  const service = newService();

  service.pushFrame = asyncMock();
  service.pushError = asyncMock();

  service._processContext = rejecting(_openaiStatusError(400));
  service.startProcessingMetrics = asyncMock();
  service.stopProcessingMetrics = asyncMock();

  const context = new LLMContext();
  await addPdf(context);
  // Simulates an earlier, separate completion that succeeded with this file.
  context.addMessage({ role: "assistant", content: "Here's a summary." });
  context.addMessage({ role: "user", content: "what does it say?" });
  const frame = new LLMContextFrame({ context });

  await service.processFrame(frame, FrameDirection.DOWNSTREAM);

  const messages = context.getMessages() as any[];
  expect(messages.length).toBe(3);
  expect(messages[2].content).toBe("what does it say?");
});

test("test_openai_llm_leaves_context_alone_on_unrelated_error", async () => {
  // Test that an unrelated error does not trigger file-message cleanup.
  const service = newService();

  service.pushFrame = asyncMock();
  service.pushError = asyncMock();
  service._processContext = rejecting(new Error("rate limited"));
  service.startProcessingMetrics = asyncMock();
  service.stopProcessingMetrics = asyncMock();

  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });
  await addPdf(context);
  const frame = new LLMContextFrame({ context });

  await service.processFrame(frame, FrameDirection.DOWNSTREAM);

  expect(context.getMessages().length).toBe(2);
});

test.each([
  [400, true],
  [422, true],
  [413, true],
  [429, false],
])(
  "test_openai_llm_file_cleanup_only_for_payload_shaped_errors[%p-%p]",
  async (statusCode, removed) => {
    // Bad request (400), unprocessable content (422), and payload too large
    // (413) indicate the request itself was bad, so the pending file is removed;
    // rate limiting (429) says nothing about the file, so it's kept for retry.
    const service = newService();

    service.pushFrame = asyncMock();
    service.pushError = asyncMock();
    service._processContext = rejecting(_openaiStatusError(statusCode));
    service.startProcessingMetrics = asyncMock();
    service.stopProcessingMetrics = asyncMock();

    const context = new LLMContext();
    context.addMessage({ role: "user", content: "hello" });
    await addPdf(context, "data:application/pdf;base64,abc123");
    const frame = new LLMContextFrame({ context });

    await service.processFrame(frame, FrameDirection.DOWNSTREAM);

    expect(context.getMessages().length).toBe(removed ? 1 : 2);
  },
);

test("test_openai_llm_async_iterator_closed_on_stream_end", async () => {
  // Test that the async iterator is explicitly closed after stream consumption.
  //
  // This prevents uvloop's broken asyncgen finalizer from firing on Python 3.12+
  // when async generators are garbage-collected without explicit cleanup.
  // See MagicStack/uvloop#699.
  const service = newService();

  // Track if the iterator's return (aclose) was called
  let iteratorAclosed = false;
  let streamClosed = false;

  // Mock async iterator that tracks return() calls.
  class MockAsyncIterator {
    iterationCount = 0;

    [Symbol.asyncIterator]() {
      return this;
    }

    async next(): Promise<IteratorResult<unknown>> {
      this.iterationCount += 1;
      if (this.iterationCount > 2) {
        return { done: true, value: undefined };
      }
      // Return a minimal chunk
      return { done: false, value: { usage: null, model: null, choices: [] } };
    }

    async return(): Promise<IteratorResult<unknown>> {
      iteratorAclosed = true;
      return { done: true, value: undefined };
    }
  }

  // Mock stream whose [Symbol.asyncIterator] returns a separate iterator object.
  class MockAsyncStream {
    controller = {
      abort: () => {
        streamClosed = true;
      },
    };

    constructor(private _iterator: MockAsyncIterator) {}

    [Symbol.asyncIterator]() {
      return this._iterator;
    }
  }

  const mockIterator = new MockAsyncIterator();
  const mockStream = new MockAsyncStream(mockIterator);

  service.getChatCompletions = asyncMock(() => mockStream);
  service.startTtfbMetrics = asyncMock();
  service.stopTtfbMetrics = asyncMock();
  service.startLlmUsageMetrics = asyncMock();

  const context = new LLMContext({ messages: [{ role: "user", content: "Hello" }] });

  await service._processContext(context);

  // Verify the iterator was explicitly closed (prevents uvloop crash)
  expect(iteratorAclosed).toBe(true);
  // Verify the stream was also closed (releases HTTP resources)
  expect(streamClosed).toBe(true);
});

test("test_openai_llm_rejected_api_key_misconfigures_the_service", async () => {
  // Test that a rejected API key marks the service as misconfigured.
  const service = newService();

  service._processContext = rejecting(
    new AuthenticationError(401, undefined, "Incorrect API key provided", new Headers()),
  );

  await service.processFrame(
    new LLMContextFrame({ context: new LLMContext() }),
    FrameDirection.DOWNSTREAM,
  );

  expect(service.isUsable).toBe(false);
});

test("test_openai_llm_server_error_leaves_the_service_usable", async () => {
  // Test that a provider-side failure leaves the service retryable.
  const service = newService();

  service._processContext = rejecting(
    new InternalServerError(500, undefined, "server had an error", new Headers()),
  );

  await service.processFrame(
    new LLMContextFrame({ context: new LLMContext() }),
    FrameDirection.DOWNSTREAM,
  );

  expect(service.isUsable).toBe(true);
});

test("test_openai_llm_starts_usable", async () => {
  // Test that a service is usable until something proves otherwise.
  //
  // The client is constructed without contacting the provider, so an invalid
  // API key builds just as happily as a valid one; only a rejected request
  // tells us anything.
  const service: any = new OpenAILLMService({
    settings: new OpenAILLMService.Settings({ model: "gpt-4" }),
  });

  expect(service.isUsable).toBe(true);
});

test("test_openai_llm_unexpected_failure_leaves_the_service_usable", async () => {
  // Test that a failure of unattributable cause is not held against the service.
  const service = newService();
  service._processContext = rejecting(new Error("boom"));

  await service.processFrame(
    new LLMContextFrame({ context: new LLMContext() }),
    FrameDirection.DOWNSTREAM,
  );

  expect(service.isUsable).toBe(true);
});
