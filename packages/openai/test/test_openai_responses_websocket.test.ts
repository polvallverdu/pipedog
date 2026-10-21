// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_responses_websocket.py

/** Tests for the WebSocket variant of OpenAIResponsesLLMService. */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CancelledError, sleep, TimeoutError } from "@pipedog/asyncio";
import {
  LLMContextFrame,
  LLMMessagesAppendFrame,
  LLMThoughtEndFrame,
  LLMThoughtStartFrame,
  LLMThoughtTextFrame,
} from "@pipedog/core/frames/frames";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import {
  _ConnectionLimitReachedError,
  _modelSupportsReasoning,
  _PreviousResponseNotFoundError,
  _ResponseTimeoutError,
  OpenAIResponsesLLMService,
  type OpenAIResponsesLLMServiceOptions,
} from "../src/responses/llm.ts";

// Tests reach into protected members.
type Any = any;

/** Create a service with the client mocked out. */
function _makeService(options: OpenAIResponsesLLMServiceOptions = {}): Any {
  const createClient = spyOn(
    OpenAIResponsesLLMService.prototype as Any,
    "_createClient",
  ).mockImplementation(() => ({}));
  try {
    const service: Any = new OpenAIResponsesLLMService({ apiKey: "test-key", ...options });
    service._client = {};
    return service;
  } finally {
    createClient.mockRestore();
  }
}

/** Build a mock WebSocket that yields the given events from recv(). */
function _wsEvents(...events: unknown[]): Any {
  // .recv() returns each event in order, then raises (like an exhausted
  // AsyncMock side_effect).
  const pending = events.map((e) => JSON.stringify(e));
  return {
    recv: mock(async () => {
      if (pending.length === 0) throw new Error("StopAsyncIteration");
      return pending.shift()!;
    }),
    send: mock(async () => {}),
    close: mock(async () => {}),
    closeCode: null,
  };
}

/** A stand-in for `MagicMock(spec=LLMContext)`. */
function mockContext(): Any {
  return Object.create(LLMContext.prototype);
}

/** `patch("...logger")`: mock the logger's level methods for the test. */
function patchLogger() {
  return {
    debug: spyOn(logger, "debug").mockImplementation(() => {}),
    info: spyOn(logger, "info").mockImplementation(() => {}),
    warning: spyOn(logger, "warning").mockImplementation(() => {}),
    error: spyOn(logger, "error").mockImplementation(() => {}),
  };
}

afterEach(() => {
  mock.restore();
});

function stubReceive(service: Any): void {
  service._pushLlmText = mock(async () => {});
  service.stopTtfbMetrics = mock(async () => {});
  service.startLlmUsageMetrics = mock(async () => {});
}

// ---------------------------------------------------------------------------
// Hash determinism
// ---------------------------------------------------------------------------

describe("TestHashInputItems", () => {
  test("test_same_input_same_hash", async () => {
    const items = [{ role: "user", content: "hello" }];
    const h1 = await OpenAIResponsesLLMService._hashInputItems(items);
    const h2 = await OpenAIResponsesLLMService._hashInputItems(items);
    expect(h1).toBe(h2);
  });

  test("test_different_input_different_hash", async () => {
    const h1 = await OpenAIResponsesLLMService._hashInputItems([
      { role: "user", content: "hello" },
    ]);
    const h2 = await OpenAIResponsesLLMService._hashInputItems([
      { role: "user", content: "world" },
    ]);
    expect(h1).not.toBe(h2);
  });

  test("test_order_independent_keys", async () => {
    // Keys within a dict should not affect hash (sort_keys=True).
    const h1 = await OpenAIResponsesLLMService._hashInputItems([{ a: 1, b: 2 }]);
    const h2 = await OpenAIResponsesLLMService._hashInputItems([{ b: 2, a: 1 }]);
    expect(h1).toBe(h2);
  });
});

describe("TestStartsWithResponseOutput", () => {
  const starts = (items: Any[], output: Any[]) =>
    OpenAIResponsesLLMService._startsWithResponseOutput(items, output);

  test("test_text_message_matches_by_role", () => {
    const responseOutput = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello!" }] },
    ];
    // Adapter produces a different format, but same role
    const items = [
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "hi" },
    ];
    expect(starts(items, responseOutput)).toBe(true);
  });

  test("test_function_call_matches_by_call_id", () => {
    const responseOutput = [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"location": "SF"}',
      },
    ];
    // Adapter format (no "id" field)
    const items = [
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
    ];
    expect(starts(items, responseOutput)).toBe(true);
  });

  test("test_mixed_output", () => {
    const responseOutput = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Let me check." }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "get_weather",
        arguments: "{}",
      },
    ];
    const items = [
      { role: "assistant", content: "Let me check." },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
    ];
    expect(starts(items, responseOutput)).toBe(true);
  });

  test("test_role_mismatch", () => {
    const responseOutput = [{ type: "message", role: "assistant", content: [] }];
    const items = [{ role: "user", content: "hi" }];
    expect(starts(items, responseOutput)).toBe(false);
  });

  test("test_text_content_mismatch", () => {
    const responseOutput = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello!" }] },
    ];
    const items = [{ role: "assistant", content: "Something completely different" }];
    expect(starts(items, responseOutput)).toBe(false);
  });

  test("test_call_id_mismatch", () => {
    const responseOutput = [{ type: "function_call", call_id: "call_1", name: "f" }];
    const items = [{ type: "function_call", call_id: "call_999", name: "f" }];
    expect(starts(items, responseOutput)).toBe(false);
  });

  test("test_too_few_items", () => {
    const responseOutput = [
      { type: "message", role: "assistant", content: [] },
      { type: "function_call", call_id: "call_1", name: "f" },
    ];
    const items = [{ role: "assistant", content: "hi" }];
    expect(starts(items, responseOutput)).toBe(false);
  });

  test("test_empty_output_always_matches", () => {
    expect(starts([], [])).toBe(true);
    expect(starts([{ role: "user" }], [])).toBe(true);
  });

  test("test_unknown_output_type_rejects", () => {
    const responseOutput = [{ type: "unknown_thing", data: "something" }];
    const items = [{ role: "assistant", content: "hi" }];
    expect(starts(items, responseOutput)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// previous_response_id optimization
// ---------------------------------------------------------------------------

describe("TestPreviousResponseOptimization", () => {
  test("test_no_previous_state_sends_full_input", async () => {
    const service = _makeService();
    const fullInput = [{ role: "user", content: "hi" }];
    const params = { input: fullInput, model: "gpt-4.1" };

    const result = await service._applyPreviousResponseOptimization(params, fullInput);

    expect(result.input).toEqual(fullInput);
    expect("previous_response_id" in result).toBe(false);
  });

  test("test_matching_prefix_sends_incremental", async () => {
    const service = _makeService();
    // Simulate: sent [user_msg], got assistant reply "hello"
    const prevInput = [{ role: "user", content: "hi" }];
    const prevOutput = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ];
    await service._storePreviousResponseState("resp_123", prevInput, prevOutput);

    // Next call: adapter produces full context including assistant reply + new user msg
    const fullInput = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you?" },
    ];
    const params = { input: [...fullInput], model: "gpt-4.1" };

    const result = await service._applyPreviousResponseOptimization(params, fullInput);

    expect(result.previous_response_id).toBe("resp_123");
    // Only the new user message should be sent
    expect(result.input).toEqual([{ role: "user", content: "how are you?" }]);
  });

  test("test_mismatched_prefix_sends_full", async () => {
    const service = _makeService();
    const prevInput = [{ role: "user", content: "hi" }];
    await service._storePreviousResponseState("resp_123", prevInput, []);

    // Different first message
    const fullInput = [
      { role: "user", content: "different" },
      { role: "assistant", content: "hello" },
    ];
    const params = { input: [...fullInput], model: "gpt-4.1" };

    const result = await service._applyPreviousResponseOptimization(params, fullInput);

    expect("previous_response_id" in result).toBe(false);
    expect(result.input).toEqual(fullInput);
  });

  test("test_same_length_sends_full", async () => {
    // When new input is same length as previous, no optimization.
    const service = _makeService();
    const prevInput = [{ role: "user", content: "hi" }];
    await service._storePreviousResponseState("resp_123", prevInput, []);

    const fullInput = [{ role: "user", content: "hi" }];
    const params = { input: [...fullInput], model: "gpt-4.1" };

    const result = await service._applyPreviousResponseOptimization(params, fullInput);

    expect("previous_response_id" in result).toBe(false);
  });

  test("test_output_mismatch_sends_full_context", async () => {
    // When prefix matches but output doesn't, fall back to full context.
    const service = _makeService();
    const prevInput = [{ role: "user", content: "hi" }];
    const prevOutput = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ];
    await service._storePreviousResponseState("resp_123", prevInput, prevOutput);

    // Aggregator stored the output differently (e.g. different role)
    const fullInput = [
      { role: "user", content: "hi" },
      { role: "developer", content: "something unexpected" },
      { role: "user", content: "how are you?" },
    ];
    const params = { input: [...fullInput], model: "gpt-4.1" };

    const result = await service._applyPreviousResponseOptimization(params, fullInput);

    expect("previous_response_id" in result).toBe(false);
    expect(result.input).toEqual(fullInput);
  });

  test("test_clear_state", async () => {
    const service = _makeService();
    await service._storePreviousResponseState("resp_123", [{ role: "user", content: "hi" }], []);
    service._clearPreviousResponseState();

    expect(service._previousResponseId).toBeNull();
    expect(service._previousInputHash).toBeNull();
    expect(service._previousInputLength).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _receive_response_events — text streaming
// ---------------------------------------------------------------------------

describe("TestReceiveResponseEventsText", () => {
  test("test_text_deltas_pushed", async () => {
    const service = _makeService();
    stubReceive(service);

    const ws = _wsEvents(
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: " world" },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-4.1",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    );
    service._websocket = ws;

    const context = mockContext();
    const fullInput = [{ role: "user", content: "hi" }];
    await service._receiveResponseEvents(context, fullInput);

    expect(service._pushLlmText).toHaveBeenCalledTimes(2);
    expect(service._pushLlmText).toHaveBeenCalledWith("Hello");
    expect(service._pushLlmText).toHaveBeenCalledWith(" world");
  });

  test("test_response_completed_stores_state", async () => {
    const service = _makeService();
    stubReceive(service);

    const ws = _wsEvents({
      type: "response.completed",
      response: {
        id: "resp_42",
        model: "gpt-4.1",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello!" }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    });
    service._websocket = ws;

    const context = mockContext();
    const fullInput = [{ role: "user", content: "hi" }];
    await service._receiveResponseEvents(context, fullInput);

    expect(service._previousResponseId).toBe("resp_42");
    expect(service._previousInputLength).toBe(1);
    expect(service._previousInputHash).not.toBeNull();
    expect(service._previousResponseOutput.length).toBe(1);
    expect(service.startLlmUsageMetrics).toHaveBeenCalled();
  });

  test("test_token_usage_metrics", async () => {
    const service = _makeService();
    stubReceive(service);

    const ws = _wsEvents({
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-4.1",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
          output_tokens_details: { reasoning_tokens: 10 },
        },
      },
    });
    service._websocket = ws;

    const context = mockContext();
    await service._receiveResponseEvents(context, []);

    const tokens = service.startLlmUsageMetrics.mock.calls.at(-1)[0];
    expect(tokens.promptTokens).toBe(100);
    expect(tokens.completionTokens).toBe(50);
    expect(tokens.totalTokens).toBe(150);
    expect(tokens.cacheReadInputTokens).toBe(20);
    // Both cache buckets sit inside input_tokens, so the totals stay as sent.
    expect(tokens.cacheCreationInputTokens).toBe(30);
    expect(tokens.reasoningTokens).toBe(10);
  });

  test("test_token_usage_metrics_without_a_cache_write_count", async () => {
    // A server without prompt caching omits the field entirely.
    const service = _makeService();
    stubReceive(service);

    const ws = _wsEvents({
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-4.1",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    service._websocket = ws;

    const context = mockContext();
    await service._receiveResponseEvents(context, []);

    const tokens = service.startLlmUsageMetrics.mock.calls.at(-1)[0];
    expect(tokens.cacheCreationInputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _receive_response_events — function calls
// ---------------------------------------------------------------------------

describe("TestReceiveResponseEventsFunctionCalls", () => {
  test("test_function_call_sequence", async () => {
    const service = _makeService();
    stubReceive(service);
    service.runFunctionCalls = mock(async () => {});

    const ws = _wsEvents(
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", name: "get_weather", call_id: "call_1" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"loc' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: 'ation": "SF"}' },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        arguments: '{"location": "SF"}',
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_1",
          name: "get_weather",
          call_id: "call_1",
          arguments: '{"location": "SF"}',
        },
      },
      { type: "response.completed", response: { id: "resp_1", model: "gpt-4.1", usage: null } },
    );
    service._websocket = ws;

    const context = mockContext();
    await service._receiveResponseEvents(context, []);

    expect(service.runFunctionCalls).toHaveBeenCalledTimes(1);
    const fcList = service.runFunctionCalls.mock.calls[0][0];
    expect(fcList.length).toBe(1);
    expect(fcList[0].functionName).toBe("get_weather");
    expect(fcList[0].toolCallId).toBe("call_1");
    expect(fcList[0].arguments).toEqual({ location: "SF" });
  });
});

// ---------------------------------------------------------------------------
// _receive_response_events — errors
// ---------------------------------------------------------------------------

describe("TestReceiveResponseEventsErrors", () => {
  function stubErrors(service: Any): void {
    service.stopTtfbMetrics = mock(async () => {});
    service.startLlmUsageMetrics = mock(async () => {});
    service.pushError = mock(async () => {});
  }

  // `push_error(error_msg=...)` is `pushError(errorMsg, ...)`: the message is
  // the first argument.
  const errorMsg = (service: Any): string => service.pushError.mock.calls.at(-1)[0];

  test("test_response_incomplete_reports_reason_and_usage", async () => {
    const service = _makeService();
    stubErrors(service);

    service._websocket = _wsEvents({
      type: "response.incomplete",
      response: {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: {
          input_tokens: 12,
          output_tokens: 50,
          total_tokens: 62,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });

    await service._receiveResponseEvents(mockContext(), []);

    expect(errorMsg(service)).toContain("max_output_tokens");
    const tokens = service.startLlmUsageMetrics.mock.calls.at(-1)[0];
    expect(tokens.promptTokens).toBe(12);
    expect(tokens.completionTokens).toBe(50);
  });

  test("test_response_failed_pushes_error", async () => {
    const service = _makeService();
    stubErrors(service);

    service._websocket = _wsEvents({
      type: "response.failed",
      response: {
        id: "resp_1",
        status: "failed",
        error: { code: "server_error", message: "The model failed to respond" },
      },
    });

    await service._receiveResponseEvents(mockContext(), []);

    expect(errorMsg(service)).toContain("The model failed to respond");
  });

  test("test_response_incomplete_pushes_error", async () => {
    const service = _makeService();
    stubErrors(service);

    service._websocket = _wsEvents({
      type: "response.incomplete",
      response: { id: "resp_1", incomplete_details: null },
    });

    await service._receiveResponseEvents(mockContext(), []);

    expect(service.pushError).toHaveBeenCalledTimes(1);
  });

  test("test_previous_response_not_found_raises", async () => {
    const service = _makeService();
    service.stopTtfbMetrics = mock(async () => {});

    service._websocket = _wsEvents({
      type: "error",
      error: {
        code: "previous_response_not_found",
        message: "Previous response with id 'resp_abc' not found.",
      },
    });

    await expect(service._receiveResponseEvents(mockContext(), [])).rejects.toThrow(
      _PreviousResponseNotFoundError,
    );
  });

  test("test_connection_limit_reached_raises", async () => {
    const service = _makeService();
    service.stopTtfbMetrics = mock(async () => {});

    service._websocket = _wsEvents({
      type: "error",
      error: { code: "websocket_connection_limit_reached", message: "Connection limit reached." },
    });

    await expect(service._receiveResponseEvents(mockContext(), [])).rejects.toThrow(
      _ConnectionLimitReachedError,
    );
  });

  test("test_generic_error_pushes_error", async () => {
    const service = _makeService();
    stubErrors(service);

    service._websocket = _wsEvents({
      type: "error",
      error: { code: "server_error", message: "Internal server error" },
    });

    await service._receiveResponseEvents(mockContext(), []);

    expect(service.pushError).toHaveBeenCalledTimes(1);
    expect(errorMsg(service)).toContain("Internal server error");
  });
});

describe("TestDrainCancelledResponse", () => {
  test("test_drain_discards_events_until_terminal", async () => {
    // Draining should discard events until a terminal event arrives.
    const service = _makeService();
    service._needsDrain = true;

    service._websocket = _wsEvents(
      { type: "response.output_text.delta", delta: "stale" },
      { type: "response.output_text.delta", delta: "also stale" },
      { type: "response.completed", response: { id: "resp_old" } },
    );

    await service._drainCancelledResponse();

    expect(service._needsDrain).toBe(false);
  });

  test("test_drain_handles_pending_cancel", async () => {
    // If cancelled before response.created, drain should send cancel once it
    // sees the response.created, then continue draining.
    const service = _makeService();
    service._needsDrain = true;
    service._cancelPendingResponse = true;

    const mockWs = _wsEvents(
      { type: "response.created", response: { id: "resp_late" } },
      { type: "response.output_text.delta", delta: "stale" },
      { type: "response.failed", response: { id: "resp_late" } },
    );
    service._websocket = mockWs;

    await service._drainCancelledResponse();

    expect(service._needsDrain).toBe(false);
    expect(service._cancelPendingResponse).toBe(false);
    // Should have sent response.cancel
    const cancelCalls = mockWs.send.mock.calls.filter((call: Any[]) =>
      String(call[0]).includes("response.cancel"),
    );
    expect(cancelCalls.length).toBe(1);
  });

  test("test_drain_timeout_clears_state", async () => {
    // If draining times out, should clear cancellation state.
    const service = _makeService();
    service._needsDrain = true;

    // recv() never returns a terminal event — times out
    service._websocket = {
      recv: mock(async () => {
        throw new TimeoutError();
      }),
    };

    await service._drainCancelledResponse();

    expect(service._needsDrain).toBe(false);
    expect(service._cancelPendingResponse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

describe("TestConnectionLifecycle", () => {
  test("test_disconnect_clears_previous_response_state", async () => {
    const service = _makeService();
    await service._storePreviousResponseState("resp_1", [{ role: "user", content: "hi" }], []);
    service.stopAllMetrics = mock(async () => {});

    await service._disconnect();

    expect(service._previousResponseId).toBeNull();
    expect(service._previousInputHash).toBeNull();
    expect(service._previousInputLength).toBeNull();
  });

  test("test_reconnect_clears_state_and_reconnects", async () => {
    const service = _makeService();
    await service._storePreviousResponseState("resp_1", [{ role: "user", content: "hi" }], []);
    service.stopAllMetrics = mock(async () => {});
    service.pushError = mock(async () => {});

    // Mock connect to set a websocket
    const mockWs = { close: mock(async () => {}) };
    service._websocket = mockWs;

    // `patch("pipecat.services.websocket_service.websocket_connect")`: the
    // service opens its connections through `_websocketConnect`.
    service._websocketConnect = mock(async () => ({}));

    // _disconnect + _connect is the lifecycle equivalent of the old _reconnect
    await service._disconnect();
    await service._connect();

    expect(service._previousResponseId).toBeNull();
    expect(mockWs.close).toHaveBeenCalledTimes(1);
  });

  test("test_cancellation_preserves_connection_and_sets_drain", async () => {
    // When process_frame is cancelled (e.g. interruption), the WebSocket
    // connection should be preserved and _needs_drain set.
    const service = _makeService();
    service.stopProcessingMetrics = mock(async () => {});
    service.pushFrame = mock(async () => {});

    const mockWs = {
      recv: mock(async () => {
        throw new CancelledError();
      }),
      send: mock(async () => {}),
    };
    service._websocket = mockWs;

    const context = new LLMContext({ messages: [{ role: "user", content: "hi" }] });

    await expect(
      service.processFrame(new LLMContextFrame({ context }), FrameDirection.DOWNSTREAM),
    ).rejects.toThrow(CancelledError);

    // Connection should be preserved, not closed
    expect(service._websocket).toBe(mockWs);
    // Should be flagged for draining before next inference
    expect(service._needsDrain).toBe(true);
  });

  test("test_ensure_connected_raises_on_failure", async () => {
    const service = _makeService();
    service._websocket = null;
    // Mock _try_reconnect to simulate exhausted retries
    service._tryReconnect = mock(async () => false);

    // DIVERGENCE: JS has no `ConnectionError`; `_ensureConnected` throws an
    // `Error` with upstream's message.
    await expect(service._ensureConnected()).rejects.toThrow(
      "failed to establish WebSocket connection",
    );
  });
});

// ---------------------------------------------------------------------------
// Reasoning — config and param building
// ---------------------------------------------------------------------------

describe("TestReasoningConfig", () => {
  test("test_config_accepts_object", () => {
    const c = new OpenAIResponsesLLMService.ReasoningConfig({
      effort: "high",
      summary: "detailed",
    });
    expect(c.effort).toBe("high");
    expect(c.summary).toBe("detailed");
  });

  test("test_config_forward_compat_effort", () => {
    // Forward compat: an unknown effort string passes through (`| str`).
    const c = new OpenAIResponsesLLMService.ReasoningConfig({ effort: "ultra" });
    expect(c.effort).toBe("ultra");
  });
});

describe("TestReasoningParams", () => {
  const _params = (service: Any) => service._buildResponseParams({ input: [] });
  const Settings = OpenAIResponsesLLMService.Settings;
  const ReasoningConfig = OpenAIResponsesLLMService.ReasoningConfig;

  test("test_default_model_gets_no_reasoning", () => {
    // The default model (gpt-4.1) does not reason, so no reasoning param is set.
    const service = _makeService();
    const params = _params(service);
    expect("reasoning" in params).toBe(false);
    expect("include" in params).toBe(false);
  });

  test("test_original_gpt_5_gets_minimal", () => {
    // The original gpt-5 models reason before most replies and reject "none".
    for (const model of ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-2025-08-07"]) {
      const service = _makeService({ settings: new Settings({ model }) });
      const params = _params(service);
      expect(params.reasoning, model).toEqual({ effort: "minimal" });
      expect("include" in params).toBe(false);
    }
  });

  test("test_later_models_get_none", () => {
    // From gpt-5.1 on, most models can skip reasoning entirely.
    for (const model of ["gpt-5.1", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol", "gpt-6-luna"]) {
      const service = _makeService({ settings: new Settings({ model }) });
      const params = _params(service);
      expect(params.reasoning, model).toEqual({ effort: "none" });
      expect("include" in params).toBe(false);
    }
  });

  test("test_models_that_must_reason_get_their_lowest_effort", () => {
    // Models that reject "none" get the lowest effort they accept.
    for (const [model, effort] of [
      ["gpt-6-astra", "low"],
      ["gpt-6.1-sol", "low"],
      ["o3", "low"],
      ["gpt-5.5-pro", "medium"],
      ["gpt-5-pro", "high"],
    ] as const) {
      const service = _makeService({ settings: new Settings({ model }) });
      const params = _params(service);
      expect(params.reasoning, model).toEqual({ effort });
    }
  });

  test("test_unlisted_models_run_at_openais_default", () => {
    // Only listed models get an effort, so a model is never sent one it rejects.
    for (const model of ["gpt-6.2", "gpt-5-codex", "gpt-4.1", "gpt-5-chat-latest"]) {
      const service = _makeService({ settings: new Settings({ model }) });
      const params = _params(service);
      expect("reasoning" in params, model).toBe(false);
    }
  });

  test("test_reasoning_in_extra_replaces_the_default", () => {
    // Reasoning passed through extra wins over the lowest-effort default.
    const service = _makeService({
      settings: new Settings({ model: "gpt-5-mini", extra: { reasoning: { effort: "low" } } }),
    });
    const params = _params(service);
    expect(params.reasoning).toEqual({ effort: "low" });
  });

  test("test_the_applied_default_is_logged_once_per_model", () => {
    // The developer learns what Pipecat sent, and when to change it, once per model.
    const service = _makeService({ settings: new Settings({ model: "gpt-5-mini" }) });
    const mockLogger = patchLogger();
    _params(service);
    _params(service);
    service._settings.model = "gpt-5-nano";
    _params(service);
    const messages = mockLogger.info.mock.calls.map((call: Any[]) => call[0] as string);
    expect(messages.length).toBe(2);
    expect(messages[0]).toContain("to gpt-5-mini,");
    expect(messages[0]).toContain("multistep reasoning");
    expect(messages[0]).toContain("set `reasoning` in OpenAIResponsesLLMService.Settings");
    expect(messages[1]).toContain("to gpt-5-nano,");
    expect(mockLogger.warning).not.toHaveBeenCalled();
  });

  test("test_an_unlisted_reasoning_model_is_warned_about_once", () => {
    // A reasoning model without a default may reason before replying, so the developer hears.
    const service = _makeService({ settings: new Settings({ model: "gpt-6.2" }) });
    const mockLogger = patchLogger();
    _params(service);
    _params(service);
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warning).toHaveBeenCalledTimes(1);
    expect(mockLogger.warning.mock.calls[0]![0]).toContain("no thinking default for gpt-6.2");
  });

  test("test_nothing_is_logged_for_a_model_that_doesnt_reason", () => {
    // Models without reasoning have no latency to recover.
    for (const model of ["gpt-4.1", "gpt-5-chat-latest", "my-azure-deployment"]) {
      const service = _makeService({ settings: new Settings({ model }) });
      const mockLogger = patchLogger();
      _params(service);
      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(mockLogger.warning).not.toHaveBeenCalled();
      mock.restore();
    }
  });

  test("test_nothing_is_logged_when_reasoning_is_configured", () => {
    // An explicit setting is the developer's choice, and needs no comment.
    const service = _makeService({
      settings: new Settings({
        model: "gpt-6.2",
        reasoning: new ReasoningConfig({ effort: "low" }),
      }),
    });
    const mockLogger = patchLogger();
    _params(service);
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warning).not.toHaveBeenCalled();
  });

  test("test_use_provider_thinking_default_runs_at_openais_default", () => {
    // The setting sends no default and logs the reason at DEBUG.
    const service = _makeService({
      settings: new Settings({ model: "gpt-5.5", useProviderThinkingDefault: true }),
    });
    const mockLogger = patchLogger();
    const params = _params(service);
    _params(service);
    expect("reasoning" in params).toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    expect(mockLogger.debug.mock.calls[0]![0]).toContain(
      "use_provider_thinking_default is set, so gpt-5.5 runs",
    );
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warning).not.toHaveBeenCalled();
  });

  test("test_use_provider_thinking_default_on_a_model_that_doesnt_reason_logs_nothing", () => {
    // A model without reasoning has no default to skip.
    const service = _makeService({
      settings: new Settings({ model: "gpt-4.1", useProviderThinkingDefault: true }),
    });
    const mockLogger = patchLogger();
    _params(service);
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warning).not.toHaveBeenCalled();
  });

  test("test_gpt_6_1_sol_explicit_effort_honored", () => {
    // An explicit effort on gpt-6.1-sol reaches the request unchanged.
    const service = _makeService({
      settings: new Settings({
        model: "gpt-6.1-sol",
        reasoning: new ReasoningConfig({ effort: "low" }),
      }),
    });
    const params = _params(service);
    expect(params.reasoning).toEqual({ effort: "low" });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("test_gpt5_chat_variant_left_untouched", () => {
    // The non-reasoning gpt-5-chat variant is excluded from the default-off logic.
    const service = _makeService({ settings: new Settings({ model: "gpt-5-chat-latest" }) });
    const params = _params(service);
    expect("reasoning" in params).toBe(false);
  });

  test("test_explicit_reasoning_overrides_default", () => {
    // An explicit config is honored as-is (not replaced by the none default).
    const service = _makeService({
      settings: new Settings({
        model: "gpt-5.5",
        reasoning: new ReasoningConfig({ effort: "high", summary: "auto" }),
      }),
    });
    const params = _params(service);
    expect(params.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("test_reasoning_mode_is_passed_through", () => {
    // `mode` reaches the request alongside `effort`.
    const service = _makeService({
      settings: new Settings({
        model: "gpt-5.6-sol",
        reasoning: new ReasoningConfig({ effort: "low", mode: "pro" }),
      }),
    });
    const params = _params(service);
    expect(params.reasoning).toEqual({ effort: "low", mode: "pro" });
  });

  test("test_empty_reasoning_config_falls_back_to_default", () => {
    // An all-unset config is treated as unconfigured.
    const service = _makeService({
      settings: new Settings({ model: "gpt-5-mini", reasoning: new ReasoningConfig() }),
    });
    const params = _params(service);
    expect(params.reasoning).toEqual({ effort: "minimal" });
    expect("include" in params).toBe(false);
  });
});

describe("TestModelSupportsReasoning", () => {
  test("test_reasoning_capable_models", () => {
    // The o-series and the mainline gpt series from gpt-5 onward reason.
    for (const model of [
      "gpt-5",
      "gpt-5.4",
      "gpt-5.5",
      "gpt-6",
      "gpt-7.1",
      "o1",
      "o3",
      "o4-mini",
    ]) {
      expect(_modelSupportsReasoning(model), model).toBe(true);
    }
  });

  test("test_known_non_reasoning_models", () => {
    // gpt-4.x and earlier, plus the gpt-5-chat variant, don't reason.
    for (const model of [
      "gpt-4.1",
      "gpt-4o",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "gpt-5-chat-latest",
    ]) {
      expect(_modelSupportsReasoning(model), model).toBe(false);
    }
  });

  test("test_unrecognized_models_are_unknown", () => {
    // An unrecognized model returns None so callers can leave it alone.
    for (const model of ["some-custom-model", "llama-3", "mistral-large"]) {
      expect(_modelSupportsReasoning(model), model).toBeNull();
    }
  });
});

describe("TestReasoningUnsupportedWarning", () => {
  // Reasoning configured on a model that can't use it should log a clear error.
  const _serviceWithReasoning = (model: string) =>
    _makeService({
      settings: new OpenAIResponsesLLMService.Settings({
        model,
        reasoning: new OpenAIResponsesLLMService.ReasoningConfig({ effort: "high" }),
      }),
    });

  test("test_warns_on_known_non_reasoning_model", () => {
    const service = _serviceWithReasoning("gpt-4.1");
    const mockLogger = patchLogger();
    service._buildResponseParams({ input: [] });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error.mock.calls.at(-1)![0]).toContain("does not support reasoning");
  });

  test("test_warns_once_per_model", () => {
    const service = _serviceWithReasoning("gpt-4.1");
    const mockLogger = patchLogger();
    service._buildResponseParams({ input: [] });
    service._buildResponseParams({ input: [] });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  test("test_no_warning_on_reasoning_capable_model", () => {
    const service = _serviceWithReasoning("gpt-5.5");
    const mockLogger = patchLogger();
    service._buildResponseParams({ input: [] });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test("test_no_warning_on_unrecognized_model", () => {
    // We can't be sure an unrecognized model lacks reasoning, so stay quiet.
    const service = _serviceWithReasoning("some-custom-model");
    const mockLogger = patchLogger();
    service._buildResponseParams({ input: [] });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// _receive_response_events — reasoning capture
// ---------------------------------------------------------------------------

describe("TestReceiveResponseEventsReasoning", () => {
  test("test_summary_streamed_and_reasoning_item_persisted", async () => {
    const service = _makeService();
    service.stopTtfbMetrics = mock(async () => {});
    service.startLlmUsageMetrics = mock(async () => {});
    service.pushFrame = mock(async () => {});
    const adapter = { createLlmSpecificMessage: mock((m: unknown) => m) };
    service.getLlmAdapter = mock(() => adapter);

    service._websocket = _wsEvents(
      { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
      { type: "response.reasoning_summary_text.delta", delta: "Think" },
      { type: "response.reasoning_summary_text.delta", delta: "ing..." },
      {
        type: "response.output_item.done",
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Thinking..." }],
          encrypted_content: "ENCRYPTED",
        },
      },
      {
        type: "response.completed",
        response: { id: "resp_1", model: "gpt-5.4-mini", usage: null },
      },
    );

    await service._receiveResponseEvents(mockContext(), []);

    const pushed: Any[] = service.pushFrame.mock.calls.map((c: Any[]) => c[0]);
    // Thought frames bracket the streamed summary: start, text, text, end.
    expect(pushed.filter((f) => f instanceof LLMThoughtStartFrame).length).toBe(1);
    expect(pushed.filter((f) => f instanceof LLMThoughtTextFrame).map((f) => f.text)).toEqual([
      "Think",
      "ing...",
    ]);
    expect(pushed.filter((f) => f instanceof LLMThoughtEndFrame).length).toBe(1);

    // The reasoning item is persisted for round-tripping, with its encrypted
    // content, via an LLMMessagesAppendFrame.
    const appendFrames = pushed.filter((f) => f instanceof LLMMessagesAppendFrame);
    expect(appendFrames.length).toBe(1);
    const stored = adapter.createLlmSpecificMessage.mock.calls.at(-1)![0];
    expect(stored).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Thinking..." }],
      encrypted_content: "ENCRYPTED",
    });
  });

  test("test_reasoning_without_encrypted_content_not_persisted", async () => {
    // No encrypted content (e.g. effort='none') → nothing to round-trip.
    const service = _makeService();
    service.stopTtfbMetrics = mock(async () => {});
    service.startLlmUsageMetrics = mock(async () => {});
    service.pushFrame = mock(async () => {});
    const adapter = { createLlmSpecificMessage: mock((m: unknown) => m) };
    service.getLlmAdapter = mock(() => adapter);

    service._websocket = _wsEvents(
      {
        type: "response.output_item.done",
        item: { type: "reasoning", id: "rs_1", summary: [] },
      },
      {
        type: "response.completed",
        response: { id: "resp_1", model: "gpt-5.4-mini", usage: null },
      },
    );

    await service._receiveResponseEvents(mockContext(), []);

    const pushed: Any[] = service.pushFrame.mock.calls.map((c: Any[]) => c[0]);
    expect(pushed.filter((f) => f instanceof LLMMessagesAppendFrame)).toEqual([]);
    expect(adapter.createLlmSpecificMessage).not.toHaveBeenCalled();
  });
});

describe("TestStartsWithResponseOutputReasoning", () => {
  test("test_reasoning_matches_by_id", () => {
    const responseOutput = [{ type: "reasoning", id: "rs_1", encrypted_content: "ENC" }];
    const items = [
      { type: "reasoning", id: "rs_1", encrypted_content: "ENC" },
      { role: "user", content: "next" },
    ];
    expect(OpenAIResponsesLLMService._startsWithResponseOutput(items, responseOutput)).toBe(true);
  });

  test("test_reasoning_id_mismatch_rejects", () => {
    const responseOutput = [{ type: "reasoning", id: "rs_1" }];
    const items = [{ type: "reasoning", id: "rs_2" }];
    expect(OpenAIResponsesLLMService._startsWithResponseOutput(items, responseOutput)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// retry_on_timeout
// ---------------------------------------------------------------------------

/**
 * Build a mock WebSocket from a script of events and float stalls.
 *
 * A dict item is delivered by recv(); a number stalls recv() for that many
 * seconds. recv() blocks indefinitely once the script is exhausted.
 */
function _wsScript(...items: unknown[]): Any {
  const pending = [...items];

  const recv = async (): Promise<string | undefined> => {
    while (pending.length > 0) {
      const item = pending.shift();
      if (typeof item === "number") {
        await sleep(item);
        continue;
      }
      return JSON.stringify(item);
    }
    await sleep(3600);
    return undefined;
  };

  return {
    recv: mock(recv),
    send: mock(async () => {}),
    close: mock(async () => {}),
    closeCode: null,
  };
}

describe("TestRetryOnTimeout", () => {
  test("test_disabled_by_default", () => {
    const service = _makeService();
    expect(service._retryOnTimeout).toBe(false);
    expect(service._retryTimeoutSecs).toBe(5.0);
  });

  test("test_silent_response_times_out", async () => {
    const service = _makeService();
    service._websocket = _wsScript();

    await expect(service._receiveResponseEvents(mockContext(), [], 0.05)).rejects.toThrow(
      _ResponseTimeoutError,
    );
  });

  test("test_response_created_alone_does_not_close_the_window", async () => {
    // An acknowledged-but-silent response is exactly what retrying is for.
    const service = _makeService();
    service._websocket = _wsScript({ type: "response.created", response: { id: "resp_1" } });

    await expect(service._receiveResponseEvents(mockContext(), [], 0.05)).rejects.toThrow(
      _ResponseTimeoutError,
    );
  });

  test("test_no_timeout_when_not_requested", async () => {
    const service = _makeService();
    stubReceive(service);
    service._websocket = _wsScript(
      0.1,
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.completed", response: { id: "resp_1", model: "gpt-4.1" } },
    );

    await service._receiveResponseEvents(mockContext(), []);

    expect(service._pushLlmText).toHaveBeenCalledTimes(1);
    expect(service._pushLlmText).toHaveBeenCalledWith("hi");
  });

  test("test_first_output_makes_the_wait_unbounded", async () => {
    // Once content is downstream, a stall must not abandon the response.
    const service = _makeService();
    stubReceive(service);
    service._websocket = _wsScript(
      { type: "response.output_text.delta", delta: "hi" },
      0.15, // longer than the timeout below
      { type: "response.completed", response: { id: "resp_1", model: "gpt-4.1" } },
    );

    await service._receiveResponseEvents(mockContext(), [], 0.05);

    expect(service._pushLlmText).toHaveBeenCalledTimes(1);
    expect(service._pushLlmText).toHaveBeenCalledWith("hi");
  });

  test("test_timeout_reconnects_and_retries_with_full_context", async () => {
    const service = _makeService({ retryOnTimeout: true, retryTimeoutSecs: 0.05 });
    service._websocket = _wsScript();
    service._ensureConnected = mock(async () => {});
    service._wsSend = mock(async () => {});
    service.startTtfbMetrics = mock(async () => {});
    service.stopTtfbMetrics = mock(async () => {});
    service._tryReconnect = mock(async () => true);

    // Stale state from an earlier turn; the retry must not reuse it.
    service._previousResponseId = "resp_stale";

    const timeouts: (number | null)[] = [];

    service._receiveResponseEvents = async (
      _context: unknown,
      _fullInput: unknown,
      outputTimeoutSecs: number | null = null,
    ) => {
      timeouts.push(outputTimeoutSecs);
      if (timeouts.length === 1) {
        throw new _ResponseTimeoutError("no output");
      }
    };

    await service._processContext(new LLMContext({ messages: [{ role: "user", content: "hi" }] }));

    // First attempt bounded, retry unbounded.
    expect(timeouts).toEqual([0.05, null]);
    expect(service._tryReconnect).toHaveBeenCalledTimes(1);
    expect(service._previousResponseId).toBeNull();
    const sent = service._wsSend.mock.calls.map((call: Any[]) => call[0]);
    expect(sent.length).toBe(2);
    expect("previous_response_id" in sent[1]).toBe(false);
  });
});
