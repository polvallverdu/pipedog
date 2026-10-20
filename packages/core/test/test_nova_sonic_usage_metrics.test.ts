// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_nova_sonic_usage_metrics.py

/**
 * AWS Nova Sonic reports token usage from its `usageEvent` stream events.
 *
 * Nova Sonic emits a `usageEvent` whose `details.delta` carries the tokens
 * consumed since the previous event, split into speech/text buckets for input and
 * output. The service collapses those buckets into the modality-agnostic
 * `LLMTokenUsage` (`promptTokens` / `completionTokens`) and reports the
 * *delta* — not the cumulative `details.total` — so usage stays incremental per
 * event, matching the other speech-to-speech services.
 *
 * Upstream imports the service with `pytest.importorskip` so the suite is skipped
 * when the optional AWS dependencies aren't installed. Here the service is
 * loaded with a dynamic import so this file still loads while
 * `packages/aws/src/nova_sonic/llm.ts` (`@pipedog/aws`) is unported; the
 * tests are `test.todo` until it lands.
 */

import { describe, expect, mock, test } from "bun:test";
import { LLMTokenUsage } from "../src/metrics/metrics.ts";

const TODO =
  "unported module: pipecat.services.aws.nova_sonic.llm (packages/aws/src/nova_sonic/llm.ts)";

// The service module is not ported yet.
type AnyService = any;

async function _service(): Promise<AnyService> {
  const modPath = "../../aws/src/nova_sonic/llm.ts";
  const mod = await import(modPath);
  return new mod.AWSNovaSonicLLMService({
    secretAccessKey: "test",
    accessKeyId: "test",
    region: "us-east-1",
  });
}

describe("TestAWSNovaSonicUsageMetrics", () => {
  test.todo(`test_can_generate_metrics (${TODO})`, async () => {
    // Without this, startLlmUsageMetrics is a no-op and nothing is emitted.
    const service = await _service();
    expect(service.canGenerateMetrics()).toBe(true);
  });

  test.todo(`test_usage_event_reports_collapsed_delta (${TODO})`, async () => {
    const service = await _service();
    service.startLlmUsageMetrics = mock(async (_tokens: LLMTokenUsage) => {});

    // A real usageEvent: delta is the increment for this event, total is the
    // cumulative session count. We report the delta, collapsing speech + text.
    await service._handleUsageEvent({
      usageEvent: {
        details: {
          delta: {
            input: { speechTokens: 0, textTokens: 3 },
            output: { speechTokens: 20, textTokens: 0 },
          },
          total: {
            input: { speechTokens: 288, textTokens: 3443 },
            output: { speechTokens: 694, textTokens: 203 },
          },
        },
      },
    });

    expect(service.startLlmUsageMetrics).toHaveBeenCalledTimes(1);
    const args = service.startLlmUsageMetrics.mock.calls[0];
    expect(args).toHaveLength(1);
    const [tokens] = args;
    expect(tokens).toBeInstanceOf(LLMTokenUsage);
    expect(tokens.promptTokens).toEqual(3); // 0 speech + 3 text
    expect(tokens.completionTokens).toEqual(20); // 20 speech + 0 text
    expect(tokens.totalTokens).toEqual(23);
  });

  test.todo(`test_usage_event_with_no_tokens_is_skipped (${TODO})`, async () => {
    // A zero-token delta (e.g. an event carrying no new usage) must not emit
    // an empty metrics frame.
    const service = await _service();
    service.startLlmUsageMetrics = mock(async () => {});

    await service._handleUsageEvent({
      usageEvent: {
        details: {
          delta: {
            input: { speechTokens: 0, textTokens: 0 },
            output: { speechTokens: 0, textTokens: 0 },
          },
        },
      },
    });

    expect(service.startLlmUsageMetrics).not.toHaveBeenCalled();
  });

  test.todo(`test_usage_event_with_missing_details_is_safe (${TODO})`, async () => {
    // A malformed/partial usageEvent must not raise and must not emit.
    const service = await _service();
    service.startLlmUsageMetrics = mock(async () => {});

    await service._handleUsageEvent({ usageEvent: {} });

    expect(service.startLlmUsageMetrics).not.toHaveBeenCalled();
  });
});
