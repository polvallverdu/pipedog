// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_llm_token_usage_totals.py

/**
 * Tests that `LLMTokenUsage.totalTokens` counts cached input tokens.
 *
 * Anthropic and Bedrock report cache reads and cache writes alongside an input count
 * that excludes them, so their totals are summed from all four component counts. On
 * services whose provider supplies the total, cached tokens are already inside it, so
 * `totalTokens` carries the same meaning everywhere.
 *
 * PORTING NOTES:
 * - `AWSBedrockLLMService` is imported by relative path from `@pipedog/aws`, which
 *   this package does not depend on.
 * - `_report_usage_metrics(**kwargs)` takes positional parameters in the port
 *   (`promptTokens, completionTokens, cacheCreation, cacheRead` for Anthropic;
 *   `promptTokens, completionTokens, cacheRead, cacheCreation` for Bedrock, as upstream).
 * - `AsyncMock` → `mock(async () => {})` assigned on the instance.
 */

import { describe, expect, mock, test } from "bun:test";
import type { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import { AWSBedrockLLMService } from "../../aws/src/llm.ts";
import { AnthropicLLMService } from "../src/llm.ts";

type Internals = any;

function _anthropicService(): Internals {
  const service = new AnthropicLLMService({ apiKey: "test-key" }) as Internals;
  service.startLlmUsageMetrics = mock(async (_tokens: LLMTokenUsage) => {});
  return service;
}

function _bedrockService(): Internals {
  const service = new AWSBedrockLLMService({
    awsAccessKey: "test-key",
    awsSecretKey: "test-secret",
    awsRegion: "us-east-1",
    settings: new AWSBedrockLLMService.Settings({
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    }),
  }) as Internals;
  service.startLlmUsageMetrics = mock(async (_tokens: LLMTokenUsage) => {});
  return service;
}

/** The single LLMTokenUsage handed to startLlmUsageMetrics. */
function _reported(service: Internals): LLMTokenUsage {
  expect(service.startLlmUsageMetrics).toHaveBeenCalledTimes(1);
  return service.startLlmUsageMetrics.mock.calls[0][0];
}

/** Anthropic totals cover the cache reads and writes reported beside the input count. */
describe("TestAnthropicTotals", () => {
  test("test_cached_reads_are_counted_in_the_total", async () => {
    // A turn billed for 2100 input tokens, only 100 of them uncached.
    const service = _anthropicService();
    await service._reportUsageMetrics(100, 50, 0, 2000);
    const usage = _reported(service);
    expect(usage.totalTokens).toBe(2150);
  });

  test("test_cache_creation_is_counted_in_the_total", async () => {
    // Writing the cache is billed too, and at a premium.
    const service = _anthropicService();
    await service._reportUsageMetrics(100, 50, 1500, 0);
    expect(_reported(service).totalTokens).toBe(1650);
  });

  test("test_the_components_are_reported_separately", async () => {
    // The total is the gross figure, so the breakdown stays available beside it.
    const service = _anthropicService();
    await service._reportUsageMetrics(100, 50, 300, 2000);
    const usage = _reported(service);
    expect(usage.promptTokens).toBe(100);
    expect(usage.cacheReadInputTokens).toBe(2000);
    expect(usage.cacheCreationInputTokens).toBe(300);
    expect(usage.totalTokens).toBe(2450);
  });

  test("test_an_uncached_turn_counts_input_plus_output", async () => {
    // With no cache activity the total is just the input and output counts.
    const service = _anthropicService();
    await service._reportUsageMetrics(100, 50, 0, 0);
    expect(_reported(service).totalTokens).toBe(150);
  });
});

/** Bedrock reports inputTokens net of the cache, so its totals are summed the same way. */
describe("TestBedrockTotals", () => {
  test("test_cached_reads_are_counted_in_the_total", async () => {
    // A turn carrying both cache reads and cache writes.
    const service = _bedrockService();
    await service._reportUsageMetrics(100, 50, 2000, 300);
    expect(_reported(service).totalTokens).toBe(2450);
  });

  test("test_a_cache_only_report_is_not_dropped", async () => {
    // Cache activity alone is enough to report usage.
    const service = _bedrockService();
    await service._reportUsageMetrics(0, 0, 2000, 0);
    expect(_reported(service).totalTokens).toBe(2000);
  });

  test("test_an_empty_report_is_skipped", async () => {
    // An all-zero report produces no usage metrics.
    const service = _bedrockService();
    await service._reportUsageMetrics(0, 0, 0, 0);
    expect(service.startLlmUsageMetrics).not.toHaveBeenCalled();
  });
});
