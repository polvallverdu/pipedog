// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_perplexity_agent_llm.py

/**
 * Tests for the requests and usage of PerplexityAgentHttpLLMService.
 *
 * Porting notes:
 * - The OpenAI JS SDK streams events as plain objects, so the `MagicMock(spec=...)`
 *   events are objects with the event's `type` (and their item's `type`).
 * - `AsyncStream.close()` is the JS stream's `controller.abort()`, so the fake
 *   stream's controller records the close.
 * - `ResponseUsage.construct(...)` is a plain usage object.
 */

import { expect, mock, test } from "bun:test";
import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LOG_LEVELS, type LogLevel, type LogRecord, logger } from "@pipedog/core/utils/logger";
import { _WithoutServerToolCalls, PerplexityAgentHttpLLMService } from "../src/llm.ts";

type Dict = Record<string, any>;

/** Access the service's protected members, as upstream's tests do. */
function internals(service: PerplexityAgentHttpLLMService): any {
  return service as any;
}

/** Collect INFO-and-above log records emitted within `fn`. */
async function _capturedLogs(fn: () => Promise<void>): Promise<LogRecord[]> {
  // loguru's sink level applies whatever the global level is.
  const previous = (Object.keys(LOG_LEVELS) as LogLevel[])
    .sort((a, b) => LOG_LEVELS[a] - LOG_LEVELS[b])
    .find((l) => logger.isEnabledFor(l));
  logger.setLevel("TRACE");
  const records: LogRecord[] = [];
  const remove = logger.addSink((record) => {
    if (LOG_LEVELS[record.level] >= LOG_LEVELS.INFO) {
      records.push(record);
    }
  });
  try {
    await fn();
  } finally {
    remove();
    if (previous) logger.setLevel(previous);
  }
  return records;
}

async function _request(
  service: PerplexityAgentHttpLLMService,
  context: LLMContext | null = null,
): Promise<Dict> {
  const ctx = context ?? new LLMContext({ messages: [{ role: "user", content: "Hi" }] });
  const invocationParams = await service.getLlmAdapter().getLlmInvocationParams(ctx);
  return internals(service)._buildResponseParams(invocationParams);
}

test("test_default_request_uses_the_fast_preset_with_a_pinned_model", async () => {
  const params = await _request(new PerplexityAgentHttpLLMService({ apiKey: "test-key" }));

  expect(params.model).toBe("openai/gpt-5.6-luna");
  expect(params.extra_body).toEqual({ preset: "fast" });
  // The preset decides how much to reason.
  expect("reasoning" in params).toBe(false);
  expect(params.tools).toEqual([{ type: "web_search" }]);
});

test("test_preset_alone_chooses_the_model", async () => {
  const service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({ model: null, preset: "fast" }),
  });
  const params = await _request(service);

  expect("model" in params).toBe(false);
  expect(params.extra_body).toEqual({ preset: "fast" });
  expect("reasoning" in params).toBe(false);
});

test("test_neither_model_nor_preset_is_rejected", () => {
  expect(
    () =>
      new PerplexityAgentHttpLLMService({
        apiKey: "test-key",
        settings: new PerplexityAgentHttpLLMService.Settings({ model: null }),
      }),
  ).toThrow("needs a `model`, a `preset`");
});

test("test_update_leaving_neither_model_nor_preset_reports_an_error", async () => {
  const service = new PerplexityAgentHttpLLMService({ apiKey: "test-key" });
  const pushError = mock(async (..._args: unknown[]) => {});
  service.pushError = pushError as any;

  await internals(service)._updateSettings(
    new PerplexityAgentHttpLLMService.Settings({ model: null }),
  );

  expect(pushError).toHaveBeenCalledTimes(1);
});

for (const model of [
  "openai/gpt-5.5",
  "anthropic/claude-haiku-4-5",
  "google/gemini-3.8-flash",
  "xai/grok-4.6",
]) {
  test(`test_every_model_gets_the_fast_preset[${model}]`, async () => {
    const service = new PerplexityAgentHttpLLMService({
      apiKey: "test-key",
      settings: new PerplexityAgentHttpLLMService.Settings({ model }),
    });
    const params = await _request(service);

    expect(params.model).toBe(model);
    expect(params.extra_body).toEqual({ preset: "fast" });
    expect("reasoning" in params).toBe(false);
  });
}

test("test_web_search_joins_context_tools_once", async () => {
  const weather = new FunctionSchema({
    name: "get_weather",
    description: "Get the weather.",
    properties: { city: { type: "string" } },
    required: ["city"],
  });
  const context = new LLMContext({
    messages: [{ role: "user", content: "Hi" }],
    tools: new ToolsSchema({ standardTools: [weather] }),
  });
  const params = await _request(new PerplexityAgentHttpLLMService({ apiKey: "test-key" }), context);

  expect((params.tools as Dict[]).map((tool) => tool.type)).toEqual(["function", "web_search"]);
});

test("test_web_search_can_be_turned_off", async () => {
  const service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({ webSearch: false }),
  });

  expect("tools" in (await _request(service))).toBe(false);
});

test("test_perplexity_fields_join_extra_body", async () => {
  const service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({
      maxSteps: 2,
      extra: { extra_body: { language_preference: "en" } },
    }),
  });

  expect((await _request(service)).extra_body).toEqual({
    language_preference: "en",
    preset: "fast",
    max_steps: 2,
  });
});

test("test_usage_reports_cache_creation_tokens", () => {
  // A plain object mirrors the SDK's lenient decode of a streamed usage
  // payload, which keeps fields it doesn't know and skips ones Perplexity
  // leaves out.
  const usage = {
    input_tokens: 3046,
    input_tokens_details: {
      cached_tokens: 1780,
      cache_creation_input_tokens: 1263,
      cache_read_input_tokens: 1780,
    },
    output_tokens: 29,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 3075,
  };
  const tokens = internals(new PerplexityAgentHttpLLMService({ apiKey: "test-key" }))._tokenUsage(
    usage,
  );

  expect(tokens.promptTokens).toBe(3046);
  expect(tokens.cacheReadInputTokens).toBe(1780);
  expect(tokens.cacheCreationInputTokens).toBe(1263);
  expect(tokens.totalTokens).toBe(3075);
});

test("test_a_preset_keeps_the_model_unless_it_is_cleared", async () => {
  let service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({ preset: "high" }),
  });
  expect((await _request(service)).model).toBe("openai/gpt-5.6-luna");

  service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({ preset: "high", model: null }),
  });
  expect("model" in (await _request(service))).toBe(false);
});

test("test_an_explicit_model_with_a_preset_keeps_the_preset_reasoning", async () => {
  const service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({
      preset: "high",
      model: "openai/gpt-5.5",
    }),
  });
  const params = await _request(service);

  expect(params.model).toBe("openai/gpt-5.5");
  expect("reasoning" in params).toBe(false);
});

test("test_explicit_reasoning_is_sent_as_configured", async () => {
  const service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({
      reasoning: new PerplexityAgentHttpLLMService.ReasoningConfig({ effort: "low" }),
    }),
  });

  const params = await _request(service);

  expect(params.reasoning).toEqual({ effort: "low" });
  expect("extra_body" in params).toBe(false);
});

test("test_a_preset_in_extra_is_left_alone", async () => {
  const service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({
      extra: { extra_body: { preset: "high" } },
    }),
  });

  expect((await _request(service)).extra_body).toEqual({ preset: "high" });
});

test("test_a_preset_update_leaves_the_model_alone", async () => {
  const service = new PerplexityAgentHttpLLMService({ apiKey: "test-key" });

  await internals(service)._updateSettings(
    new PerplexityAgentHttpLLMService.Settings({ preset: "high" }),
  );

  expect(internals(service)._settings.model).toBe("openai/gpt-5.6-luna");
});

test("test_provider_thinking_default_sends_no_preset", async () => {
  const service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({ useProviderThinkingDefault: true }),
  });
  const params = await _request(service);

  expect(params.model).toBe("openai/gpt-5.6-luna");
  expect("extra_body" in params).toBe(false);
  expect("reasoning" in params).toBe(false);
});

test("test_provider_thinking_default_keeps_a_chosen_preset", async () => {
  const service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({
      preset: "fast",
      useProviderThinkingDefault: true,
    }),
  });

  expect((await _request(service)).extra_body).toEqual({ preset: "fast" });
});

test("test_the_default_preset_is_logged_once", async () => {
  const service = new PerplexityAgentHttpLLMService({ apiKey: "test-key" });

  const records = await _capturedLogs(async () => {
    await _request(service);
    await _request(service);
  });

  const infos = records
    .filter((r) => r.level === "INFO" && r.message.includes("preset"))
    .map((r) => r.message);
  expect(infos.length).toBe(1);
  expect(infos[0]).toContain("'preset': 'fast'");
});

test("test_a_chosen_preset_is_not_logged", async () => {
  const service = new PerplexityAgentHttpLLMService({
    apiKey: "test-key",
    settings: new PerplexityAgentHttpLLMService.Settings({ preset: "high" }),
  });

  const records = await _capturedLogs(async () => {
    await _request(service);
  });

  expect(records.filter((r) => r.message.includes("preset"))).toEqual([]);
});

/** Stand-in for the OpenAI SDK's stream that yields preset events. */
class _FakeStream {
  #events: Dict[];
  closed = false;
  iteratorClosed = false;
  // `AsyncStream.close()` is `controller.abort()` in the JS SDK.
  controller = new AbortController();

  constructor(events: Iterable<Dict>) {
    this.#events = [...events];
    this.controller.signal.addEventListener("abort", () => {
      this.closed = true;
    });
  }

  async *#iterator(): AsyncGenerator<Dict, void, undefined> {
    try {
      for (const event of this.#events) {
        yield event;
      }
    } finally {
      this.iteratorClosed = true;
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<Dict, void, undefined> {
    return this.#iterator();
  }
}

function _callAdded(outputIndex: number, itemId: string, name: string): Dict {
  return {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { type: "function_call", id: itemId, name, call_id: `call_${itemId}` },
  };
}

function _argumentsDelta(outputIndex: number, itemId: string, delta: string): Dict {
  return {
    type: "response.function_call_arguments.delta",
    output_index: outputIndex,
    item_id: itemId,
    delta,
  };
}

function _callDone(outputIndex: number, itemId: string, name: string, args: string): Dict {
  return {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: { type: "function_call", id: itemId, name, call_id: `call_${itemId}`, arguments: args },
  };
}

function _searchResultsDone(outputIndex: number): Dict {
  return {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: { type: "search_results" }, // a search_results item, with no id
  };
}

function _textDelta(delta: string): Dict {
  return { type: "response.output_text.delta", delta };
}

async function _filtered(...events: Dict[]): Promise<Dict[]> {
  const out: Dict[] = [];
  for await (const event of new _WithoutServerToolCalls(new _FakeStream(events) as any)) {
    out.push(event as Dict);
  }
  return out;
}

test("test_a_search_the_server_runs_is_dropped", async () => {
  const searchAdded = _callAdded(0, "fc_1", "search_web");
  const searchDone = _searchResultsDone(0);
  const text = _textDelta("Sunny.");

  const result = await _filtered(searchAdded, searchDone, text);
  expect(result.length).toBe(2);
  expect(result[0]).toBe(searchDone);
  expect(result[1]).toBe(text);
});

test("test_a_function_call_passes_through_in_order", async () => {
  const added = _callAdded(1, "fc_2", "get_weather");
  const delta = _argumentsDelta(1, "fc_2", '{"city": "Paris"}');
  const text = _textDelta("Checking.");
  const done = _callDone(1, "fc_2", "get_weather", '{"city": "Paris"}');

  // The announcement waits for the call's output to complete; other events don't.
  const result = await _filtered(added, delta, text, done);
  expect(result.length).toBe(4);
  expect(result[0]).toBe(delta);
  expect(result[1]).toBe(text);
  expect(result[2]).toBe(added);
  expect(result[3]).toBe(done);
});

test("test_closing_the_filter_closes_the_stream", async () => {
  const stream = new _FakeStream([_textDelta("a"), _textDelta("b")]);
  const filtered = new _WithoutServerToolCalls(stream as any);
  const events = filtered[Symbol.asyncIterator]();

  await events.next();
  await events.return?.();
  await filtered.close();

  expect(stream.iteratorClosed).toBe(true);
  expect(stream.closed).toBe(true);
});

test("test_only_application_function_calls_run", async () => {
  const service = new PerplexityAgentHttpLLMService({ apiKey: "test-key" });
  const s = internals(service);
  s.startTtfbMetrics = mock(async () => {});
  s.stopTtfbMetrics = mock(async () => {});
  s.startLlmUsageMetrics = mock(async () => {});
  s._pushLlmText = mock(async () => {});
  const runFunctionCalls = mock(async (..._args: unknown[]) => {});
  s.runFunctionCalls = runFunctionCalls;
  const adapter = {
    getMessagesForLogging: mock(() => []),
    getLlmInvocationParams: mock(async () => ({})),
  };
  s.getLlmAdapter = mock(() => adapter);
  s._buildResponseParams = mock(() => ({}));
  s._client = {
    responses: {
      create: mock(
        async () =>
          new _FakeStream([
            _callAdded(0, "fc_1", "search_web"),
            _searchResultsDone(0),
            _callAdded(1, "fc_2", "get_weather"),
            _callDone(1, "fc_2", "get_weather", '{"city": "Paris"}'),
          ]),
      ),
    },
  };

  await s._processContext(new LLMContext());

  const functionCalls = runFunctionCalls.mock.calls.at(-1)![0] as Dict[];
  expect(functionCalls.map((fc) => fc.functionName)).toEqual(["get_weather"]);
});
