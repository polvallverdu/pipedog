// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_google_stream_timeout.py

/** Tests for the streamed-response timeouts and retry in GoogleLLMService. */

import { expect, mock, test } from "bun:test";

import { ApiError, FinishReason, GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { LLMContextConversionError } from "@pipedog/core/adapters/llm/base_llm_adapter";
import {
  type ErrorFrame,
  LLMFullResponseEndFrame,
  LLMTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { GoogleLLMService, type GoogleLLMServiceOptions } from "../src/llm.ts";

// Short enough to keep tests quick, long enough to outlast scheduling jitter.
const IDLE_TIMEOUT = 0.2;
const RETRY_TIMEOUT = 0.05;

type Generator = (signal?: AbortSignal) => AsyncGenerator<GenerateContentResponse, void, unknown>;

const sleep = (secs: number) => new Promise<void>((resolve) => setTimeout(resolve, secs * 1000));

/**
 * Wait forever, the counterpart of `await asyncio.Event().wait()`.
 *
 * In Python the pending wait is cancelled when the service gives up on the
 * stream; in JS the service aborts the request's signal instead, so the wait
 * ends (with an error) when that signal fires.
 */
function stall(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Build a single streamed chunk, optionally carrying text. */
function _chunk(
  text: string | null = null,
  finishReason: FinishReason | null = null,
): GenerateContentResponse {
  const parts = text !== null ? [{ text }] : [];
  const candidate: Record<string, unknown> = { content: { role: "model", parts } };
  if (finishReason !== null) candidate.finishReason = finishReason;
  return Object.assign(new GenerateContentResponse(), { candidates: [candidate] });
}

/**
 * Hand out one canned stream per attempt, recording the attempts made.
 *
 * @returns A generator factory and the list of attempts it has served. The
 *   last generator is reused if the service asks for more streams than supplied.
 */
function _attempts(...generators: Generator[]): [Generator, null[]] {
  const attempts: null[] = [];

  const factory: Generator = (signal) => {
    attempts.push(null);
    return (generators[Math.min(attempts.length, generators.length) - 1] as Generator)(signal);
  };

  return [factory, attempts];
}

/**
 * Run a context through the service against a canned stream.
 *
 * @returns The pushed frames, any errors pushed upstream, and the names of any
 *   service events fired.
 */
async function _stream(
  generator: Generator,
  timeout: number | null = IDLE_TIMEOUT,
  serviceOptions: Partial<GoogleLLMServiceOptions> = {},
): Promise<[unknown[], string[], string[]]> {
  const service = new GoogleLLMService({
    apiKey: "test-key",
    streamIdleTimeoutSecs: timeout,
    ...serviceOptions,
  });
  const frames: unknown[] = [];
  const errors: string[] = [];
  const events: string[] = [];

  service.eventHandler("on_completion_timeout", async (_) => {
    events.push("on_completion_timeout");
  });

  (service as any).pushFrame = async (frame: unknown, _direction?: unknown) => {
    frames.push(frame);
  };
  (service as any)._streamContent = async (_context: LLMContext, signal?: AbortSignal) =>
    generator(signal);
  (service as any).pushErrorFrame = async (error: ErrorFrame) => {
    errors.push(error.error);
  };

  await (service as any)._processContext(new LLMContext());

  // Event handlers run as background tasks, so give them a turn to finish.
  await sleep(0.05);
  return [frames, errors, events];
}

function texts(frames: unknown[]): string[] {
  return frames.filter((f) => f instanceof LLMTextFrame).map((f) => (f as LLMTextFrame).text);
}

test("test_completed_stream_does_not_time_out", async () => {
  // A stream that closes normally ends on its own terms.
  async function* generator() {
    yield _chunk("Hello there.");
    yield _chunk(null, FinishReason.STOP);
  }

  const [frames, errors, events] = await _stream(generator);

  expect(texts(frames)).toEqual(["Hello there."]);
  expect(errors).toEqual([]);
  expect(events).toEqual([]);
});

test("test_stalled_stream_times_out_and_closes_the_response", async () => {
  // A stream that stops producing without closing is bounded, not waited on forever.
  async function* generator(signal?: AbortSignal) {
    yield _chunk("Starting to answer");
    await stall(signal);
  }

  const [frames, errors, events] = await _stream(generator);

  expect(errors).toEqual(["LLM completion timeout"]);
  expect(events).toEqual(["on_completion_timeout"]);
  // The text that did arrive is kept, and the response is still closed so the
  // aggregator downstream isn't left waiting on a turn that will never end.
  expect(texts(frames)).toEqual(["Starting to answer"]);
  expect(frames[frames.length - 1]).toBeInstanceOf(LLMFullResponseEndFrame);
});

test("test_slow_stream_is_not_cut_short", async () => {
  // The timeout covers the gap between chunks, not the response as a whole.
  async function* generator() {
    for (let i = 0; i < 5; i++) {
      await sleep(IDLE_TIMEOUT / 2);
      yield _chunk(`chunk${i} `);
    }
    yield _chunk(null, FinishReason.STOP);
  }

  const [frames, errors, events] = await _stream(generator);

  // Total run outlasts the idle timeout several times over without tripping it.
  expect(frames.filter((f) => f instanceof LLMTextFrame).length).toBe(5);
  expect(errors).toEqual([]);
  expect(events).toEqual([]);
});

test("test_timeout_can_be_disabled", async () => {
  // Passing null waits on the stream indefinitely.
  async function* generator() {
    await sleep(IDLE_TIMEOUT * 3);
    yield _chunk("Worth the wait.");
    yield _chunk(null, FinishReason.STOP);
  }

  const [frames, errors, events] = await _stream(generator, null);

  expect(texts(frames)).toEqual(["Worth the wait."]);
  expect(errors).toEqual([]);
  expect(events).toEqual([]);
});

test("test_stalled_first_chunk_is_not_retried_by_default", async () => {
  // Re-issuing a request is opt-in, since the wait covers the model's thinking.
  async function* stalled(signal?: AbortSignal): AsyncGenerator<GenerateContentResponse> {
    await stall(signal);
    yield* []; // unreachable, keeps this an async generator
  }

  const [factory, attempts] = _attempts(stalled);
  const [, errors, events] = await _stream(factory);

  expect(attempts.length).toBe(1);
  expect(errors).toEqual(["LLM completion timeout"]);
  expect(events).toEqual(["on_completion_timeout"]);
});

test("test_stalled_first_chunk_is_retried", async () => {
  // A request that is accepted and then produces nothing is issued again.
  async function* stalled(signal?: AbortSignal): AsyncGenerator<GenerateContentResponse> {
    await stall(signal);
    yield* []; // unreachable, keeps this an async generator
  }

  async function* answered() {
    yield _chunk("Second time lucky.");
    yield _chunk(null, FinishReason.STOP);
  }

  const [factory, attempts] = _attempts(stalled, answered);
  const [frames, errors, events] = await _stream(factory, IDLE_TIMEOUT, {
    retryOnTimeout: true,
    retryTimeoutSecs: RETRY_TIMEOUT,
  });

  expect(attempts.length).toBe(2);
  expect(texts(frames)).toEqual(["Second time lucky."]);
  expect(errors).toEqual([]);
  expect(events).toEqual([]);
});

test("test_stream_that_stalls_after_its_first_chunk_is_not_retried", async () => {
  // Once a chunk is downstream, re-issuing would duplicate the response.
  async function* generator(signal?: AbortSignal) {
    yield _chunk("Starting to answer");
    await stall(signal);
  }

  const [factory, attempts] = _attempts(generator);
  const [frames, errors, events] = await _stream(factory, IDLE_TIMEOUT, {
    retryOnTimeout: true,
    retryTimeoutSecs: RETRY_TIMEOUT,
  });

  expect(attempts.length).toBe(1);
  expect(texts(frames)).toEqual(["Starting to answer"]);
  expect(errors).toEqual(["LLM completion timeout"]);
  expect(events).toEqual(["on_completion_timeout"]);
});

test("test_request_is_re_issued_only_once", async () => {
  // A second stall ends the turn rather than issuing a third request.
  async function* stalled(signal?: AbortSignal): AsyncGenerator<GenerateContentResponse> {
    await stall(signal);
    yield* []; // unreachable, keeps this an async generator
  }

  const [factory, attempts] = _attempts(stalled);
  const [, errors, events] = await _stream(factory, IDLE_TIMEOUT, {
    retryOnTimeout: true,
    retryTimeoutSecs: RETRY_TIMEOUT,
  });

  expect(attempts.length).toBe(2);
  expect(errors).toEqual(["LLM completion timeout"]);
  expect(events).toEqual(["on_completion_timeout"]);
});

test("test_abandoned_stream_is_closed", async () => {
  // The stream left behind by a retry doesn't hold its HTTP resources open.
  const closed: string[] = [];

  async function* stalled(signal?: AbortSignal): AsyncGenerator<GenerateContentResponse> {
    try {
      await stall(signal);
      yield* []; // unreachable, keeps this an async generator
    } finally {
      closed.push("stalled");
    }
  }

  async function* answered() {
    try {
      yield _chunk("Second time lucky.");
      yield _chunk(null, FinishReason.STOP);
    } finally {
      closed.push("answered");
    }
  }

  const [factory] = _attempts(stalled, answered);
  await _stream(factory, IDLE_TIMEOUT, { retryOnTimeout: true, retryTimeoutSecs: RETRY_TIMEOUT });

  expect(closed).toEqual(["stalled", "answered"]);
});

test("test_client_stream_can_be_closed", async () => {
  // Closing an abandoned stream reaches the API client's own stream object.
  //
  // The tests above stand in canned async generators, which support `return()`
  // by construction. This one holds the real client to the same contract, since
  // a stream that can't be closed is one whose HTTP resources leak on a retry.
  //
  // Unlike the Python client, the JS client sends the request when the stream
  // is created, so it is pointed at a local server that accepts the request
  // and never sends a chunk.
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          // Flush the response headers, then hold the stream open.
          start(controller) {
            controller.enqueue(new TextEncoder().encode("\n"));
          },
        }),
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
  });
  try {
    const client = new GoogleGenAI({
      apiKey: "test-key",
      httpOptions: { baseUrl: `http://localhost:${server.port}` },
    });

    const stream = await client.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: "Hello",
    });

    expect(typeof (stream as any).return).toBe("function");
    await stream.return(undefined);
  } finally {
    server.stop(true);
  }
});

test("test_timeouts_are_enabled_by_default", () => {
  // The stream is bounded unless a caller opts out.
  const service = new GoogleLLMService({ apiKey: "test-key" });

  expect((service as any)._streamIdleTimeoutSecs).toBe(20.0);
  expect((service as any)._retryTimeoutSecs).toBe(5.0);
  expect((service as any)._retryOnTimeout).toBe(false);
});

/** The JS SDK's counterpart of the Python SDK's `ClientError` / `ServerError`. */
function apiError(status: number, body: Record<string, unknown>): ApiError {
  return new ApiError({ message: `got status: ${status}. ${JSON.stringify(body)}`, status });
}

const FILE = "data:application/pdf;base64,ZmFrZSBwZGY=";

/** Run `_processContext` with a `_streamContent` that throws `error`. */
async function _processWithError(service: GoogleLLMService, context: LLMContext, error: unknown) {
  (service as any).pushFrame = mock(async () => {});
  (service as any).pushError = mock(async () => {});
  (service as any)._streamContent = async (_context: LLMContext) => {
    throw error;
  };
  await (service as any)._processContext(context);
}

test("test_google_llm_removes_file_message_on_client_error", async () => {
  // A 4xx ClientError from Gemini triggers file-message cleanup.
  //
  // This prevents the context from getting permanently stuck retrying a file
  // Gemini has already rejected (unsupported MIME type, corrupt bytes, etc.).
  const service = new GoogleLLMService({ apiKey: "test-key" });

  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });
  await context.addFileFrameMessage({ type: "bytes", format: "application/pdf", file: FILE });

  await _processWithError(
    service,
    context,
    apiError(400, { error: { code: 400, message: "bad file", status: "INVALID_ARGUMENT" } }),
  );

  const messages = context.getMessages() as any[];
  expect(messages.length).toBe(1);
  expect(messages[0].content).toBe("hello");
});

test("test_google_llm_removes_file_message_on_context_conversion_error", async () => {
  // An LLMContextConversionError also triggers file-message cleanup.
  //
  // Corrupt file data (e.g. malformed base64) fails during local message
  // conversion, before any request reaches Gemini at all — so this never
  // surfaces as a ClientError, but it's just as much evidence the file was
  // the problem.
  const service = new GoogleLLMService({ apiKey: "test-key" });

  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });
  await context.addFileFrameMessage({ type: "bytes", format: "application/pdf", file: FILE });

  await _processWithError(
    service,
    context,
    new LLMContextConversionError(new Error("Incorrect padding")),
  );

  const messages = context.getMessages() as any[];
  expect(messages.length).toBe(1);
  expect(messages[0].content).toBe("hello");
});

test("test_google_llm_removes_file_message_despite_newer_message", async () => {
  // Test that the right file message is found even if it's no longer the newest.
  //
  // A file arriving alongside a separately-aggregated user utterance (e.g. the
  // user was mid-turn when the file was sent) can end up with a plain-text
  // message added after it, before either has gone through a completion. The
  // file should still be identified as the removal candidate.
  const service = new GoogleLLMService({ apiKey: "test-key" });

  const context = new LLMContext();
  await context.addFileFrameMessage({ type: "bytes", format: "application/pdf", file: FILE });
  context.addMessage({ role: "user", content: "what does it say?" });

  await _processWithError(
    service,
    context,
    apiError(400, { error: { code: 400, message: "bad file", status: "INVALID_ARGUMENT" } }),
  );

  const messages = context.getMessages() as any[];
  expect(messages.length).toBe(1);
  expect(messages[0].content).toBe("what does it say?");
});

test("test_google_llm_leaves_a_confirmed_file_message_alone", async () => {
  // Test that a file already confirmed accepted by a prior completion is untouched.
  //
  // Once an assistant reply has followed the file, it's no longer a removal
  // candidate — a later, unrelated turn erroring out shouldn't discard it.
  const service = new GoogleLLMService({ apiKey: "test-key" });

  const context = new LLMContext();
  await context.addFileFrameMessage({ type: "bytes", format: "application/pdf", file: FILE });
  // Simulates an earlier, separate completion that succeeded with this file.
  context.addMessage({ role: "assistant", content: "Here's a summary." });
  context.addMessage({ role: "user", content: "what does it say?" });

  await _processWithError(
    service,
    context,
    apiError(400, { error: { code: 400, message: "bad file", status: "INVALID_ARGUMENT" } }),
  );

  const messages = context.getMessages() as any[];
  expect(messages.length).toBe(3);
  expect(messages[2].content).toBe("what does it say?");
});

test("test_google_llm_leaves_context_alone_on_server_error", async () => {
  // A 5xx ServerError from Gemini does not trigger file-message cleanup.
  //
  // A server-side failure isn't evidence that our request (or its file) was
  // bad, so the message should survive to be retried.
  const service = new GoogleLLMService({ apiKey: "test-key" });

  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });
  await context.addFileFrameMessage({ type: "bytes", format: "application/pdf", file: FILE });

  await _processWithError(
    service,
    context,
    apiError(500, { error: { code: 500, message: "internal error", status: "INTERNAL" } }),
  );

  expect(context.getMessages().length).toBe(2);
});

test("test_google_llm_leaves_context_alone_on_resource_exhausted_error", async () => {
  // A RESOURCE_EXHAUSTED ClientError from Gemini does not trigger file-message cleanup.
  //
  // Rate limiting arrives as a 4xx ClientError like INVALID_ARGUMENT does,
  // but it says nothing about whether the request (or its file) was bad —
  // removing the file wouldn't help the next retry succeed, and would just
  // discard it for no reason.
  const service = new GoogleLLMService({ apiKey: "test-key" });

  const context = new LLMContext();
  context.addMessage({ role: "user", content: "hello" });
  await context.addFileFrameMessage({ type: "bytes", format: "application/pdf", file: FILE });

  await _processWithError(
    service,
    context,
    apiError(429, {
      error: { code: 429, message: "rate exceeded", status: "RESOURCE_EXHAUSTED" },
    }),
  );

  expect(context.getMessages().length).toBe(2);
});
