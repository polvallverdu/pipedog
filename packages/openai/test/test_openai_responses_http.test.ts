// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_responses_http.py

/** Tests for the HTTP variant of OpenAIResponsesHttpLLMService. */

import { describe, expect, mock, spyOn, test } from "bun:test";

import { sleep } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMMessagesAppendFrame,
  LLMServiceMetadataFrame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
} from "@pipedog/core/frames/frames";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { runTest } from "@pipedog/core/tests/utils";
import { logger } from "@pipedog/core/utils/logger";
import { APIConnectionTimeoutError } from "openai";

import { OpenAIResponsesHttpLLMService } from "../src/responses/llm.ts";

type Dict = Record<string, any>;
type AnyMock = ReturnType<typeof mock>;

/** The service with its protected members reachable, as upstream does. */
type Service = OpenAIResponsesHttpLLMService & Dict;

/** Create an HTTP service with the client and metrics hooks mocked out. */
function _makeService(options: Dict = {}): Service {
  const service = new OpenAIResponsesHttpLLMService({
    apiKey: "test-key",
    ...options,
  }) as Service;

  service._client = { responses: { create: mock(async () => null) } };
  service.startTtfbMetrics = mock(async () => {});
  service.stopTtfbMetrics = mock(async () => {});
  service.startLlmUsageMetrics = mock(async () => {});
  service._pushLlmText = mock(async () => {});

  // Skip the adapter / param-building plumbing; we only exercise the
  // streaming completion handler here.
  const adapter = {
    getMessagesForLogging: mock(() => []),
    getLlmInvocationParams: mock(async () => ({})),
    createLlmSpecificMessage: mock((m: unknown) => m),
  };
  service.getLlmAdapter = mock(() => adapter);
  service._buildResponseParams = mock(() => ({}));

  return service;
}

/** Minimal stand-in for the OpenAI SDK stream that yields preset events. */
class _FakeAsyncStream {
  #events: Dict[];

  constructor(events: Dict[]) {
    this.#events = [...events];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Dict> {
    for (const event of this.#events) {
      yield event;
    }
  }

  async close(): Promise<void> {}
}

/** Build a response.completed event carrying the given usage object. */
function _completedEvent(usage: Dict): Dict {
  // Upstream's response is a MagicMock, whose `output` iterates as empty.
  return { type: "response.completed", response: { usage, model: "gpt-4.1", output: [] } };
}

/** Drive _processContext over a fake stream of the given events. */
async function _run(service: Service, ...events: Dict[]): Promise<void> {
  service._client.responses.create = mock(async () => new _FakeAsyncStream(events));
  await service._processContext(new LLMContext());
}

/** Build a response.failed event whose response carries the given error object. */
function _failedEvent(error: Dict | null, usage: Dict | null = null): Dict {
  return { type: "response.failed", response: { error, usage } };
}

/** Build a response.incomplete event carrying the given incomplete_details. */
function _incompleteEvent(incompleteDetails: Dict | null, usage: Dict | null = null): Dict {
  return {
    type: "response.incomplete",
    response: { incomplete_details: incompleteDetails, usage },
  };
}

/** Build a top-level error event with the given message. */
function _errorEvent(message: string): Dict {
  return { type: "error", message };
}

/** Build a response.output_text.delta event carrying the given delta. */
function _textDeltaEvent(text: string): Dict {
  return { type: "response.output_text.delta", delta: text };
}

function _tokens(service: Service): LLMTokenUsage {
  return (service.startLlmUsageMetrics as AnyMock).mock.calls.at(-1)![0] as LLMTokenUsage;
}

function _errorMsg(service: Service): string {
  return (service.pushError as unknown as AnyMock).mock.calls.at(-1)![0] as string;
}

// ---------------------------------------------------------------------------
// _process_context — token usage parsing
// ---------------------------------------------------------------------------

describe("TestHttpTokenUsageMetrics", () => {
  test("test_token_usage_with_details", async () => {
    // Native OpenAI responses (detail objects present) pass through unchanged.
    const service = _makeService();

    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
      output_tokens_details: { reasoning_tokens: 10 },
    };
    await _run(service, _completedEvent(usage));

    const tokens = _tokens(service);
    expect(tokens.promptTokens).toBe(100);
    expect(tokens.completionTokens).toBe(50);
    expect(tokens.totalTokens).toBe(150);
    expect(tokens.cacheReadInputTokens).toBe(20);
    // Both cache buckets sit inside input_tokens, so the totals stay as sent.
    expect(tokens.cacheCreationInputTokens).toBe(30);
    expect(tokens.reasoningTokens).toBe(10);
  });

  test("test_token_usage_with_missing_details", async () => {
    // A third-party server may omit input/output token detail sub-objects.
    // The handler must not raise and must fall back to 0 for
    // cache/reasoning tokens.
    const service = _makeService();

    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: null,
      output_tokens_details: null,
    };
    await _run(service, _completedEvent(usage));

    expect(service.startLlmUsageMetrics).toHaveBeenCalled();
    const tokens = _tokens(service);
    expect(tokens.promptTokens).toBe(10);
    expect(tokens.completionTokens).toBe(5);
    expect(tokens.totalTokens).toBe(15);
    expect(tokens.cacheReadInputTokens).toBe(0);
    expect(tokens.cacheCreationInputTokens).toBe(0);
    expect(tokens.reasoningTokens).toBe(0);
  });

  test("test_token_usage_with_empty_details", async () => {
    // A third-party server may send empty detail sub-objects. The handler
    // must coalesce the missing fields to 0 rather than leak null into
    // metrics.
    const service = _makeService();

    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: {},
      output_tokens_details: {},
    };
    await _run(service, _completedEvent(usage));

    expect(service.startLlmUsageMetrics).toHaveBeenCalled();
    const tokens = _tokens(service);
    expect(tokens.cacheReadInputTokens).toBe(0);
    expect(tokens.cacheCreationInputTokens).toBe(0);
    expect(tokens.reasoningTokens).toBe(0);
  });

  test("test_token_usage_with_missing_top_level_counts", async () => {
    // A third-party server may omit the top-level token counts. The handler
    // must coalesce them to 0 so metrics never receive null.
    const service = _makeService();

    await _run(service, _completedEvent({ input_tokens: 10 }));

    expect(service.startLlmUsageMetrics).toHaveBeenCalled();
    const tokens = _tokens(service);
    expect(tokens.promptTokens).toBe(10);
    expect(tokens.completionTokens).toBe(0);
    expect(tokens.totalTokens).toBe(0);
    expect(tokens.cacheReadInputTokens).toBe(0);
    expect(tokens.cacheCreationInputTokens).toBe(0);
    expect(tokens.reasoningTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _process_context — reasoning capture
// ---------------------------------------------------------------------------

describe("TestHttpReasoningCapture", () => {
  test("test_summary_streamed_and_reasoning_item_persisted", async () => {
    const service = _makeService();
    service.pushFrame = mock(async () => {});
    const adapter = service.getLlmAdapter() as unknown as Dict;

    const delta1 = { type: "response.reasoning_summary_text.delta", delta: "Think" };
    const delta2 = { type: "response.reasoning_summary_text.delta", delta: "ing..." };

    const item = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ text: "Thinking..." }],
      encrypted_content: "ENCRYPTED",
    };
    const done = { type: "response.output_item.done", item };

    await _run(service, delta1, delta2, done);

    const pushed = (service.pushFrame as unknown as AnyMock).mock.calls.map((c) => c[0] as Frame);
    expect(pushed.filter((f) => f instanceof LLMThoughtStartFrame).length).toBe(1);
    expect(
      pushed
        .filter((f) => f instanceof LLMThoughtTextFrame)
        .map((f) => (f as LLMThoughtTextFrame).text),
    ).toEqual(["Think", "ing..."]);
    expect(pushed.filter((f) => f instanceof LLMThoughtEndFrame).length).toBe(1);

    const appendFrames = pushed.filter((f) => f instanceof LLMMessagesAppendFrame);
    expect(appendFrames.length).toBe(1);
    const stored = adapter.createLlmSpecificMessage.mock.calls.at(-1)[0];
    expect(stored).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Thinking..." }],
      encrypted_content: "ENCRYPTED",
    });
  });
});

// ---------------------------------------------------------------------------
// _process_context — in-stream terminal error events
// ---------------------------------------------------------------------------

/**
 * In-stream terminal events must surface an error, not an empty turn.
 *
 * Errors raised before streaming starts are handled by the caller's catch
 * blocks. These events arrive on an otherwise healthy 200 stream, so without
 * an explicit branch the loop ends and the turn looks successful.
 */
describe("TestHttpStreamErrorEvents", () => {
  test("test_response_failed_pushes_error", async () => {
    const service = _makeService();
    service.pushError = mock(async () => {});

    await _run(service, _failedEvent({ message: "Content filter triggered" }));

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(_errorMsg(service)).toContain("Content filter triggered");
  });

  test("test_response_failed_without_error_details", async () => {
    // A third-party server may omit the error object on a failed response;
    // the handler must still push an error rather than raise.
    const service = _makeService();
    service.pushError = mock(async () => {});

    await _run(service, _failedEvent(null));

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(_errorMsg(service)).toContain("Response failed");
  });

  test("test_response_failed_with_empty_error_message", async () => {
    // A server may send an error object whose message is empty. The generic
    // fallback must still apply.
    const service = _makeService();
    service.pushError = mock(async () => {});

    await _run(service, _failedEvent({ message: null }));

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(_errorMsg(service)).toContain("Response failed");
  });

  test("test_response_incomplete_pushes_error", async () => {
    const service = _makeService();
    service.pushError = mock(async () => {});

    await _run(service, _incompleteEvent({ reason: "max_output_tokens" }));

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(_errorMsg(service)).toContain("max_output_tokens");
  });

  test("test_response_incomplete_reports_token_usage", async () => {
    // A response cut short is billed for the tokens it used.
    const service = _makeService();
    service.pushError = mock(async () => {});

    const usage = {
      input_tokens: 12,
      output_tokens: 50,
      total_tokens: 62,
      input_tokens_details: null,
      output_tokens_details: null,
    };
    await _run(service, _incompleteEvent({ reason: "max_output_tokens" }, usage));

    const tokens = _tokens(service);
    expect(tokens.promptTokens).toBe(12);
    expect(tokens.completionTokens).toBe(50);
    expect(tokens.totalTokens).toBe(62);
  });

  test("test_response_failed_reports_token_usage", async () => {
    const service = _makeService();
    service.pushError = mock(async () => {});

    const usage = {
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
      input_tokens_details: null,
      output_tokens_details: null,
    };
    await _run(service, _failedEvent({ message: "server_error" }, usage));

    const tokens = _tokens(service);
    expect(tokens.promptTokens).toBe(12);
    expect(tokens.completionTokens).toBe(3);
  });

  test("test_response_incomplete_without_details", async () => {
    const service = _makeService();
    service.pushError = mock(async () => {});

    await _run(service, _incompleteEvent(null));

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(_errorMsg(service)).toContain("Response incomplete");
  });

  test("test_error_event_pushes_error", async () => {
    const service = _makeService();
    service.pushError = mock(async () => {});

    await _run(service, _errorEvent("Internal server error"));

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(_errorMsg(service)).toContain("Internal server error");
  });

  test("test_real_sdk_events_are_read_from_the_right_fields", async () => {
    // Drive events shaped the way the streaming decoder produces them.
    // `failed` and `incomplete` carry their detail on different fields.
    const failed = {
      type: "response.failed",
      sequence_number: 1,
      response: { error: { code: "server_error", message: "Content filter triggered" } },
    };
    const incomplete = {
      type: "response.incomplete",
      sequence_number: 1,
      response: { incomplete_details: { reason: "max_output_tokens" } },
    };
    const error = {
      type: "error",
      sequence_number: 1,
      message: "Internal server error",
      code: null,
      param: null,
    };

    for (const [event, expected] of [
      [failed, "Content filter triggered"],
      [incomplete, "max_output_tokens"],
      [error, "Internal server error"],
    ] as [Dict, string][]) {
      const service = _makeService();
      service.pushError = mock(async () => {});

      await _run(service, event);

      expect(service.pushError).toHaveBeenCalledTimes(1);
      expect(_errorMsg(service)).toContain(expected);
    }
  });

  test("test_terminal_error_stops_consuming_the_stream", async () => {
    // A terminal event ends the turn: later events must not be processed.
    const service = _makeService();
    service.pushError = mock(async () => {});

    await _run(
      service,
      _failedEvent({ message: "Content filter triggered" }),
      _textDeltaEvent("should not be spoken"),
    );

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(service._pushLlmText).not.toHaveBeenCalled();
  });

  test("test_terminal_error_does_not_run_announced_function_call", async () => {
    // A function call whose arguments never finished streaming before a
    // terminal error must not be executed with fabricated empty arguments.
    const service = _makeService();
    service.pushError = mock(async () => {});
    service.runFunctionCalls = mock(async () => {});

    const added = {
      type: "response.output_item.added",
      item: { type: "function_call", id: "item_1", name: "get_weather", call_id: "call_1" },
    };
    const delta = {
      type: "response.function_call_arguments.delta",
      item_id: "item_1",
      delta: '{"city": "SF"',
    };

    await _run(service, added, delta, _failedEvent({ message: "upstream provider error" }));

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(service.runFunctionCalls).not.toHaveBeenCalled();
  });

  test("test_terminal_error_still_runs_completed_function_calls", async () => {
    // Parallel tool calls: a call whose arguments finished streaming before
    // the terminal error (e.g. a later item truncated by max_output_tokens)
    // must still run — only the unfinished call is dropped.
    const service = _makeService();
    service.pushError = mock(async () => {});
    service.runFunctionCalls = mock(async () => {});

    const _toolCallAdded = (itemId: string, name: string, callId: string): Dict => ({
      type: "response.output_item.added",
      item: { type: "function_call", id: itemId, name, call_id: callId },
    });

    const argsDone = {
      type: "response.function_call_arguments.done",
      item_id: "item_1",
      arguments: '{"city": "SF"}',
    };

    const itemDone = {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "item_1",
        name: "get_weather",
        call_id: "call_1",
        arguments: '{"city": "SF"}',
      },
    };

    const partialDelta = {
      type: "response.function_call_arguments.delta",
      item_id: "item_2",
      delta: '{"city": "NY',
    };

    await _run(
      service,
      _toolCallAdded("item_1", "get_weather", "call_1"),
      argsDone,
      itemDone,
      _toolCallAdded("item_2", "get_time", "call_2"),
      partialDelta,
      _incompleteEvent({ reason: "max_output_tokens" }),
    );

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(service.runFunctionCalls).toHaveBeenCalledTimes(1);
    const fcList = (service.runFunctionCalls as unknown as AnyMock).mock.calls[0]![0] as Dict[];
    expect(fcList.map((fc) => fc.functionName)).toEqual(["get_weather"]);
    expect(fcList[0]!.arguments).toEqual({ city: "SF" });
  });

  test("test_response_failed_reaches_pipeline_as_error_frame", async () => {
    // Pipeline-level check: an in-stream response.failed event must surface
    // as an ErrorFrame, which is what failover strategies react to.
    const service = _makeService();

    service._client.responses.create = mock(
      async () => new _FakeAsyncStream([_failedEvent({ message: "upstream provider error" })]),
    );

    const context = new LLMContext();

    const [downFrames, upFrames] = await runTest(service, {
      framesToSend: [new LLMContextFrame({ context })],
      expectedDownFrames: [
        LLMServiceMetadataFrame,
        LLMFullResponseStartFrame,
        LLMFullResponseEndFrame,
      ],
    });

    const errorFrames = [...downFrames, ...upFrames].filter((f) => f instanceof ErrorFrame);
    // Expected an ErrorFrame after an in-stream response.failed event.
    expect(errorFrames.length).toBeGreaterThan(0);
  });
});

/** A response that completes with no text and no function call is reported. */
describe("TestHttpEmptyResponse", () => {
  const _completed = (output: Dict[]): Dict => ({
    type: "response.completed",
    response: { id: "resp_1", model: "gpt-5.4-mini", usage: null, output },
  });

  const _message = (content: Dict[]): Dict => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content,
  });

  /** Returns the service and the messages passed to `logger.warning`. */
  const _runEmpty = async (...events: Dict[]): Promise<[Service, string[]]> => {
    const service = _makeService();
    service.pushError = mock(async () => {});
    service.runFunctionCalls = mock(async () => {});
    const mockWarning = spyOn(logger, "warning");
    let warnings: string[];
    try {
      await _run(service, ...events);
    } finally {
      // mockRestore() clears the recorded calls, so copy them first.
      warnings = mockWarning.mock.calls.map((c) => c[0]);
      mockWarning.mockRestore();
    }
    return [service, warnings];
  };

  test("test_reasoning_only_response_pushes_error", async () => {
    const reasoning = { id: "rs_1", type: "reasoning", summary: [] };
    const [service, mockWarning] = await _runEmpty(_completed([reasoning]));

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(_errorMsg(service)).toContain("resp_1");
    expect(mockWarning.at(-1)).toContain("['reasoning']");
  });

  test("test_refusal_is_named_in_the_warning", async () => {
    const refusal = { type: "refusal", refusal: "I can't help with that." };
    const [service, mockWarning] = await _runEmpty(_completed([_message([refusal])]));

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(mockWarning.at(-1)).toContain("['message[refusal]']");
  });

  test("test_text_response_pushes_no_error", async () => {
    const text = { type: "output_text", text: "Hello", annotations: [] };
    const [service, mockWarning] = await _runEmpty(
      _textDeltaEvent("Hello"),
      _completed([_message([text])]),
    );

    expect(service.pushError).not.toHaveBeenCalled();
    expect(mockWarning).toEqual([]);
  });

  test("test_function_call_only_response_pushes_no_error", async () => {
    const call = {
      id: "fc_1",
      type: "function_call",
      name: "end_session",
      call_id: "call_1",
      arguments: "{}",
    };
    const added = { type: "response.output_item.added", item: call };
    const done = { type: "response.output_item.done", item: call };
    const [service] = await _runEmpty(added, done, _completed([call]));

    expect(service.pushError).not.toHaveBeenCalled();
    expect(service.runFunctionCalls).toHaveBeenCalledTimes(1);
  });

  test("test_empty_response_reaches_pipeline_as_error_frame", async () => {
    const service = _makeService();
    const reasoning = { id: "rs_1", type: "reasoning", summary: [] };
    service._client.responses.create = mock(
      async () => new _FakeAsyncStream([_completed([reasoning])]),
    );

    const [downFrames, upFrames] = await runTest(service, {
      framesToSend: [new LLMContextFrame({ context: new LLMContext() })],
      expectedDownFrames: [
        LLMServiceMetadataFrame,
        LLMFullResponseStartFrame,
        LLMFullResponseEndFrame,
      ],
    });

    const errorFrames = [...downFrames, ...upFrames].filter((f) => f instanceof ErrorFrame);
    expect(errorFrames.length).toBe(1);
    // Upstream also asserts `not error_frames[0].fatal`; `ErrorFrame.fatal`
    // (and FatalErrorFrame) are deprecated upstream and not ported, so every
    // ErrorFrame here is non-fatal.
  });
});

// ---------------------------------------------------------------------------
// retry_on_timeout
// ---------------------------------------------------------------------------

describe("TestHttpRetryOnTimeout", () => {
  test("test_disabled_by_default", () => {
    const service = _makeService();
    expect(service._retryOnTimeout).toBe(false);
    expect(service._retryTimeoutSecs).toBe(5.0);
  });

  test("test_no_timeout_applied_when_disabled", async () => {
    const service = _makeService();

    const slowCreate = async (): Promise<_FakeAsyncStream> => {
      await sleep(0.1);
      return new _FakeAsyncStream([]);
    };

    service._client.responses.create = mock(slowCreate);

    await service._createStream({});

    expect(service._client.responses.create).toHaveBeenCalledTimes(1);
  });

  test("test_reissues_request_on_timeout", async () => {
    const service = _makeService({ retryOnTimeout: true, retryTimeoutSecs: 0.05 });

    const stream = new _FakeAsyncStream([]);
    const attempts: Dict[] = [];

    const create = async (kwargs: Dict): Promise<_FakeAsyncStream> => {
      attempts.push(kwargs);
      if (attempts.length === 1) {
        await sleep(10);
      }
      return stream;
    };

    service._client.responses.create = mock(create);

    expect(await service._createStream({ model: "gpt-4.1" })).toBe(stream);
    expect(attempts.length).toBe(2);
  });

  test("test_retry_is_unbounded", async () => {
    // The retry must outlive retryTimeoutSecs, or it would be pointless.
    const service = _makeService({ retryOnTimeout: true, retryTimeoutSecs: 0.05 });

    const stream = new _FakeAsyncStream([]);
    let attempts = 0;

    const create = async (): Promise<_FakeAsyncStream> => {
      attempts += 1;
      if (attempts === 1) {
        await sleep(10);
      }
      await sleep(0.15); // longer than retryTimeoutSecs
      return stream;
    };

    service._client.responses.create = mock(create);

    expect(await service._createStream({})).toBe(stream);
    expect(attempts).toBe(2);
  });

  test("test_api_timeout_error_also_retries", async () => {
    const service = _makeService({ retryOnTimeout: true, retryTimeoutSecs: 0.05 });

    const stream = new _FakeAsyncStream([]);
    let attempts = 0;

    const create = async (): Promise<_FakeAsyncStream> => {
      attempts += 1;
      if (attempts === 1) {
        throw new APIConnectionTimeoutError();
      }
      return stream;
    };

    service._client.responses.create = mock(create);

    expect(await service._createStream({})).toBe(stream);
    expect(attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// _build_response_params — default reasoning effort
// ---------------------------------------------------------------------------

describe("TestHttpReasoningParams", () => {
  const _params = (model: string): Dict => {
    // Built without _makeService, which stubs out _buildResponseParams.
    const service = new OpenAIResponsesHttpLLMService({
      apiKey: "test-key",
      settings: new OpenAIResponsesHttpLLMService.Settings({ model }),
    });
    return service._buildResponseParams({ input: [] } as any);
  };

  test("test_listed_models_get_their_effort", () => {
    // Models listed in the reasoning defaults get their lowest effort.
    expect(_params("gpt-5-mini").reasoning).toEqual({ effort: "minimal" });
    expect(_params("gpt-5.5").reasoning).toEqual({ effort: "none" });
    expect(_params("o3").reasoning).toEqual({ effort: "low" });
  });

  test("test_unlisted_models_run_at_openais_default", () => {
    // Every other model is left at the provider default.
    for (const model of ["gpt-6.2", "gpt-4.1"]) {
      expect("reasoning" in _params(model)).toBe(false);
    }
  });
});
