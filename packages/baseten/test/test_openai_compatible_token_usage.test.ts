// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_compatible_token_usage.py

/**
 * Tests that OpenAI-compatible services report token usage once per completion.
 *
 * Providers differ in how often they send usage: some once at the end, others
 * a cumulative snapshot on every streamed chunk. The base streaming loop holds
 * the latest snapshot and reports it when the completion finishes, so a single
 * turn produces a single usage metric either way.
 *
 * Porting notes:
 * - `patch.object(cls, "create_client")` → `spyOn` on the prototype's
 *   `createClient`; `patch.object(FrameProcessor, "start_llm_usage_metrics")`
 *   → `spyOn(FrameProcessor.prototype, ...)`.
 * - The other providers' services are imported from their packages' sources
 *   in this workspace.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CancelledError } from "@pipedog/asyncio";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { NovitaLLMService } from "../../novita/src/llm.ts";
import { PerplexityLLMService } from "../../perplexity/src/llm.ts";
import { SambaNovaLLMService } from "../../sambanova/src/llm.ts";
import { BasetenLLMService } from "../src/llm.ts";

type ServiceClass = typeof OpenAILLMService;

const SERVICES: [string, ServiceClass, Record<string, unknown>][] = [
  ["openai", OpenAILLMService, { apiKey: "test-key" }],
  ["baseten", BasetenLLMService as unknown as ServiceClass, { apiKey: "test-key" }],
  ["novita", NovitaLLMService as unknown as ServiceClass, { apiKey: "test-key" }],
  ["perplexity", PerplexityLLMService as unknown as ServiceClass, { apiKey: "test-key" }],
  ["sambanova", SambaNovaLLMService as unknown as ServiceClass, { apiKey: "test-key" }],
];

// Not ported yet: the services in pipecat.services.xai.llm (grok) and
// pipecat.services.nvidia.llm (nvidia).
test.todo("grok: needs pipecat.services.xai.llm (@pipedog/xai)");
test.todo("nvidia: needs pipecat.services.nvidia.llm (@pipedog/nvidia)");

/** Build a stream chunk carrying a cumulative usage snapshot. */
function usageChunk(promptTokens: number, completionTokens: number, reasoningTokens = 0): any {
  return {
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    },
    model: null,
    choices: [],
  };
}

/**
 * Stands in for the provider's chat completion stream.
 *
 * Satisfies the base streaming loop, which iterates and then closes the
 * stream, as well as SambaNova's copy of it.
 */
function fakeStream(chunks: unknown[], raiseAtEnd: unknown = null): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
      if (raiseAtEnd) {
        throw raiseAtEnd;
      }
    },
  };
}

const spies: { mockRestore(): void }[] = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** A service whose stream yields the given chunks. */
function service(
  serviceClass: ServiceClass,
  initKwargs: Record<string, unknown>,
  chunks: unknown[],
  raiseAtEnd: unknown = null,
): any {
  const createClient = spyOn(serviceClass.prototype, "createClient").mockImplementation(
    () => ({}) as any,
  );
  const svc: any = new serviceClass({
    settings: new serviceClass.Settings({ model: "test-model" }),
    ...initKwargs,
  });
  createClient.mockRestore();
  svc._client = {};
  svc.getChatCompletions = mock(async () => fakeStream(chunks, raiseAtEnd));
  svc.startTtfbMetrics = mock(async () => {});
  svc.stopTtfbMetrics = mock(async () => {});
  return svc;
}

function context(): LLMContext {
  return new LLMContext({ messages: [{ role: "user", content: "Hi" }] });
}

function reportedSpy() {
  const spy = spyOn(FrameProcessor.prototype, "startLlmUsageMetrics").mockImplementation(
    async () => {},
  );
  spies.push(spy);
  return spy;
}

function usageOf(spy: ReturnType<typeof reportedSpy>, call = 0): LLMTokenUsage {
  return spy.mock.calls[call]![0] as LLMTokenUsage;
}

describe.each(SERVICES)("%s", (_id, serviceClass, initKwargs) => {
  test("test_the_snapshots_are_reported_once_as_a_final_total", async () => {
    // Three snapshots for one completion produce one report of the last.
    const svc = service(serviceClass, initKwargs, [
      usageChunk(20, 5),
      usageChunk(20, 12),
      usageChunk(20, 30),
    ]);

    const reported = reportedSpy();
    await svc._processContext(context());

    expect(reported).toHaveBeenCalledTimes(1);
    const usage = usageOf(reported);
    expect(usage.promptTokens).toBe(20);
    expect(usage.completionTokens).toBe(30);
    expect(usage.totalTokens).toBe(50);
  });

  test("test_usage_is_reported_when_the_response_is_interrupted", async () => {
    // A completion cancelled mid-stream still reports the latest snapshot once.
    const svc = service(
      serviceClass,
      initKwargs,
      [usageChunk(20, 5), usageChunk(20, 12)],
      new CancelledError(),
    );

    const reported = reportedSpy();
    await expect(svc._processContext(context())).rejects.toThrow(CancelledError);

    expect(reported).toHaveBeenCalledTimes(1);
    expect(usageOf(reported).completionTokens).toBe(12);
  });

  test("test_cached_and_reasoning_counts_reach_the_report", async () => {
    // The snapshot is reported whole, so every count the provider sent survives.
    const chunk = usageChunk(20, 30, 8);
    chunk.usage.prompt_tokens_details.cached_tokens = 15;
    const svc = service(serviceClass, initKwargs, [chunk]);

    const reported = reportedSpy();
    await svc._processContext(context());

    const usage = usageOf(reported);
    expect(usage.cacheReadInputTokens).toBe(15);
    expect(usage.reasoningTokens).toBe(8);
  });

  test("test_cache_write_counts_reach_the_report", async () => {
    // Cache writes are billed above the input rate, so they have to survive the
    // report as their own count rather than disappearing into prompt_tokens.
    const chunk = usageChunk(20, 30);
    chunk.usage.prompt_tokens_details.cached_tokens = 12;
    chunk.usage.prompt_tokens_details.cache_write_tokens = 8;
    const svc = service(serviceClass, initKwargs, [chunk]);

    const reported = reportedSpy();
    await svc._processContext(context());

    const usage = usageOf(reported);
    expect(usage.cacheCreationInputTokens).toBe(8);
    expect(usage.cacheReadInputTokens).toBe(12);
    // the provider's own totals stay exactly as sent
    expect(usage.promptTokens).toBe(20);
    expect(usage.totalTokens).toBe(50);
  });

  test("test_a_provider_that_sends_no_cache_write_field_still_reports", async () => {
    // Older SDKs and providers without prompt caching send no such field. That
    // must read as absent, not raise and not become a zero that looks measured.
    const chunk = usageChunk(20, 30);
    delete chunk.usage.prompt_tokens_details.cache_write_tokens;
    const svc = service(serviceClass, initKwargs, [chunk]);

    const reported = reportedSpy();
    await svc._processContext(context());

    expect(usageOf(reported).cacheCreationInputTokens).toBeNull();
  });

  test("test_a_completion_without_usage_reports_nothing", async () => {
    // Streams that carry no usage snapshot produce no metrics.
    const svc = service(serviceClass, initKwargs, [{ usage: null, model: null, choices: [] }]);

    const reported = reportedSpy();
    await svc._processContext(context());

    expect(reported).not.toHaveBeenCalled();
  });

  test("test_a_later_completion_does_not_inherit_earlier_usage", async () => {
    // Each completion starts from a clean slate.
    const svc = service(serviceClass, initKwargs, [usageChunk(20, 30)]);

    const reported = reportedSpy();
    await svc._processContext(context());

    svc.getChatCompletions = mock(async () =>
      fakeStream([{ usage: null, model: null, choices: [] }]),
    );
    await svc._processContext(context());

    expect(reported).toHaveBeenCalledTimes(1);
  });
});
