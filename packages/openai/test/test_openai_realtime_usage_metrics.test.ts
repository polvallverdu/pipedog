// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_openai_realtime_usage_metrics.py

/**
 * Tests for OpenAI Realtime token usage reporting.
 *
 * Covers:
 * - `response.done` usage details (audio/cached breakdown) land on the
 *   `LLMTokenUsage` passed to `startLlmUsageMetrics`.
 * - Missing detail objects degrade to null fields rather than errors.
 * - `_addTokenUsageToSpan` emits the audio token span attributes for
 *   both `LLMTokenUsage` objects and plain dicts.
 */

import { beforeAll, expect, mock, test } from "bun:test";

import { LLMTokenUsage } from "@pipedog/core/metrics/metrics";
import { _addTokenUsageToSpan } from "@pipedog/core/utils/tracing/service_decorators";
import { loadOpenTelemetry } from "@pipedog/core/utils/tracing/setup";

import * as events from "../src/realtime/events.ts";
import { OpenAIRealtimeLLMService } from "../src/realtime/llm.ts";

// Upstream runs with opentelemetry installed, so `is_tracing_available()` is
// true; wait for core's automatic import of `@opentelemetry/api`.
beforeAll(async () => {
  await loadOpenTelemetry();
});

// ---------------------------------------------------------------------------
// response.done -> LLMTokenUsage
// ---------------------------------------------------------------------------

function _responseDoneEvt(usage: Record<string, unknown>): events.ResponseDone {
  return events.ResponseDone.modelValidate({
    event_id: "ev_1",
    type: "response.done",
    response: {
      id: "resp_1",
      object: "realtime.response",
      status: "completed",
      status_details: null,
      output: [],
      usage,
    },
  });
}

/** The protected members these tests reach into, as upstream does. */
interface Internals {
  startLlmUsageMetrics: ReturnType<typeof mock>;
  stopProcessingMetrics: ReturnType<typeof mock>;
  pushFrame: ReturnType<typeof mock>;
  _callEventHandler: ReturnType<typeof mock>;
  pushError: ReturnType<typeof mock>;
  _currentAudioResponse: unknown;
  _handleEvtResponseDone(evt: events.ResponseDone): Promise<void>;
}

function _serviceForUsageCapture(): Internals {
  const service = new OpenAIRealtimeLLMService({
    apiKey: "test-key",
    settings: new OpenAIRealtimeLLMService.Settings({ model: "gpt-realtime" }),
  });
  const internals = service as unknown as Internals;
  internals.startLlmUsageMetrics = mock(async () => {});
  internals.stopProcessingMetrics = mock(async () => {});
  internals.pushFrame = mock(async () => {});
  internals._callEventHandler = mock(async () => {});
  internals._currentAudioResponse = null;
  return internals;
}

test("test_response_done_reports_audio_and_cached_audio_tokens", async () => {
  const service = _serviceForUsageCapture();
  const evt = _responseDoneEvt({
    total_tokens: 100,
    input_tokens: 60,
    output_tokens: 40,
    input_token_details: {
      cached_tokens: 30,
      text_tokens: 20,
      audio_tokens: 40,
      cached_tokens_details: { text_tokens: 10, audio_tokens: 20 },
    },
    output_token_details: { text_tokens: 15, audio_tokens: 25 },
  });

  await service._handleEvtResponseDone(evt);

  const tokens = service.startLlmUsageMetrics.mock.lastCall![0] as LLMTokenUsage;
  expect(tokens.promptTokens).toBe(60);
  expect(tokens.completionTokens).toBe(40);
  expect(tokens.totalTokens).toBe(100);
  expect(tokens.cacheReadInputTokens).toBe(30);
  expect(tokens.inputAudioTokens).toBe(40);
  expect(tokens.outputAudioTokens).toBe(25);
  expect(tokens.cacheReadInputAudioTokens).toBe(20);
});

test("test_response_done_without_cached_details_reports_none", async () => {
  const service = _serviceForUsageCapture();
  const evt = _responseDoneEvt({
    total_tokens: 10,
    input_tokens: 6,
    output_tokens: 4,
    input_token_details: { cached_tokens: 0, text_tokens: 6, audio_tokens: 0 },
    output_token_details: { text_tokens: 4, audio_tokens: 0 },
  });

  await service._handleEvtResponseDone(evt);

  const tokens = service.startLlmUsageMetrics.mock.lastCall![0] as LLMTokenUsage;
  expect(tokens.cacheReadInputAudioTokens).toBeNull();
  expect(tokens.inputAudioTokens).toBe(0);
  expect(tokens.outputAudioTokens).toBe(0);
});

test("test_response_done_without_usage_reports_no_usage", async () => {
  const service = _serviceForUsageCapture();
  const evt = events.ResponseDone.modelValidate({
    event_id: "ev_1",
    type: "response.done",
    response: { status: "completed" },
  });

  await service._handleEvtResponseDone(evt);

  expect(service.startLlmUsageMetrics).not.toHaveBeenCalled();
  expect(service.stopProcessingMetrics).toHaveBeenCalledTimes(1);
});

test("test_failed_response_without_status_details_pushes_error", async () => {
  const service = _serviceForUsageCapture();
  service.pushError = mock(async () => {});
  const evt = events.ResponseDone.modelValidate({
    event_id: "ev_1",
    type: "response.done",
    response: { status: "failed" },
  });

  await service._handleEvtResponseDone(evt);

  expect(service.pushError).toHaveBeenCalledTimes(1);
  expect(service.pushError).toHaveBeenCalledWith("Response failed");
});

// ---------------------------------------------------------------------------
// _addTokenUsageToSpan
// ---------------------------------------------------------------------------

class _FakeSpan {
  attributes: Record<string, unknown> = {};

  setAttribute(key: string, value: unknown): void {
    this.attributes[key] = value;
  }
}

type Span = Parameters<typeof _addTokenUsageToSpan>[0];

test("test_span_attributes_from_llm_token_usage_object", () => {
  const span = new _FakeSpan();
  _addTokenUsageToSpan(
    span as unknown as Span,
    new LLMTokenUsage({
      promptTokens: 60,
      completionTokens: 40,
      totalTokens: 100,
      cacheReadInputTokens: 30,
      inputAudioTokens: 40,
      outputAudioTokens: 25,
      cacheReadInputAudioTokens: 20,
    }),
  );
  expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(60);
  expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(40);
  expect(span.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(30);
  expect(span.attributes["gen_ai.usage.audio.input_tokens"]).toBe(40);
  expect(span.attributes["gen_ai.usage.audio.output_tokens"]).toBe(25);
  expect(span.attributes["gen_ai.usage.audio.cache_read.input_tokens"]).toBe(20);
});

test("test_span_attributes_omitted_when_audio_fields_unset", () => {
  const span = new _FakeSpan();
  _addTokenUsageToSpan(
    span as unknown as Span,
    new LLMTokenUsage({ promptTokens: 6, completionTokens: 4, totalTokens: 10 }),
  );
  expect("gen_ai.usage.audio.input_tokens" in span.attributes).toBe(false);
  expect("gen_ai.usage.audio.output_tokens" in span.attributes).toBe(false);
  expect("gen_ai.usage.audio.cache_read.input_tokens" in span.attributes).toBe(false);
});

test("test_span_attributes_from_dict", () => {
  const span = new _FakeSpan();
  _addTokenUsageToSpan(span as unknown as Span, {
    prompt_tokens: 60,
    completion_tokens: 40,
    input_audio_tokens: 40,
    output_audio_tokens: 25,
    cache_read_input_audio_tokens: 20,
  });
  expect(span.attributes["gen_ai.usage.audio.input_tokens"]).toBe(40);
  expect(span.attributes["gen_ai.usage.audio.output_tokens"]).toBe(25);
  expect(span.attributes["gen_ai.usage.audio.cache_read.input_tokens"]).toBe(20);
});
