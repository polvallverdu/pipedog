// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_gemini_live_tracing.py

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tracedGeminiLive } from "../src/utils/tracing/service_decorators.ts";
import {
  getOpenTelemetry,
  type OpenTelemetryModules,
  type OtelApi,
  type OtelTracer,
  registerOpenTelemetry,
} from "../src/utils/tracing/setup.ts";

// Upstream skips the suite unless opentelemetry is installed. `@opentelemetry/api`
// is an optional peer of core; it and `@opentelemetry/sdk-trace-base` are core
// devDependencies, so the suite runs here. They are still loaded optionally, as
// upstream does (module names in variables keep TypeScript from requiring them).
const OTEL_API = "@opentelemetry/api";
const OTEL_SDK = "@opentelemetry/sdk-trace-base";

interface ReadableSpan {
  name: string;
  attributes: Record<string, unknown>;
}

interface OtelSdk {
  BasicTracerProvider: new (
    config?: Record<string, unknown>,
  ) => {
    getTracer(name: string, version?: string): OtelTracer;
  };
  SimpleSpanProcessor: new (exporter: unknown) => unknown;
  InMemorySpanExporter: new () => {
    getFinishedSpans(): ReadableSpan[];
    reset(): void;
  };
}

let api: OtelApi | null = null;
let sdk: OtelSdk | null = null;
try {
  api = (await import(OTEL_API)) as unknown as OtelApi;
  sdk = (await import(OTEL_SDK)) as unknown as OtelSdk;
} catch {
  api = null;
  sdk = null;
}
const HAS_OPENTELEMETRY = api !== null && sdk !== null;

/**
 * Minimal stand-in for the Gemini Live service.
 *
 * Exposes only the attributes the `tracedGeminiLive` decorator reads, and
 * a `_toolResult` method decorated exactly as the real service decorates it
 * — same operation, same positional signature `(toolCallId, toolName,
 * toolResultMessage)`.
 */
class _StubGeminiLiveService {
  _tracingEnabled = true;
  _tracingContext = null;
  _settings = null;
  _modelName = "gemini-live-test";

  /** No-op body; the decorator is what we're exercising. */
  async _toolResult(
    _toolCallId: string,
    _toolName: string,
    _toolResultMessage: unknown,
  ): Promise<null> {
    return null;
  }

  static {
    const proto = _StubGeminiLiveService.prototype as unknown as Record<string, unknown>;
    proto._toolResult = tracedGeminiLive("llm_tool_result")(proto._toolResult);
  }
}

/**
 * Tests for the `llm_tool_result` branch of `tracedGeminiLive`.
 *
 * Regression coverage for the decorator reading the decorated method's
 * positional arguments (`toolCallId`, `toolCallName`, `result`).
 * The previous implementation treated `args[0]` — actually the
 * `toolCallId` string — as a dict of result fields, so it captured
 * nothing and every `tool.*` attribute silently went missing from the span.
 */
describe.skipIf(!HAS_OPENTELEMETRY)("TestGeminiLiveToolResultTracing", () => {
  let exporter: InstanceType<OtelSdk["InMemorySpanExporter"]>;
  let previous: OpenTelemetryModules | null = null;

  // Wire an in-memory span exporter into the tracer the decorator resolves
  // via `trace.getTracer("pipecat")`. Upstream attaches the processor to the
  // global provider (which can only be set once per process); here the
  // registered API's `trace.getTracer` is pointed at our own provider instead,
  // which leaves any global provider untouched.
  beforeAll(() => {
    const otelSdk = sdk as OtelSdk;
    const otelApi = api as OtelApi;
    exporter = new otelSdk.InMemorySpanExporter();
    const processor = new otelSdk.SimpleSpanProcessor(exporter);
    const provider = new otelSdk.BasicTracerProvider({ spanProcessors: [processor] });
    const trace = Object.create(otelApi.trace) as OtelApi["trace"];
    trace.getTracer = (name: string, version?: string) => provider.getTracer(name, version);
    previous = getOpenTelemetry();
    registerOpenTelemetry({ api: { ...otelApi, trace, context: otelApi.context } });
  });

  afterAll(() => {
    registerOpenTelemetry(previous);
  });

  beforeEach(() => {
    exporter.reset();
  });

  function _toolResultSpan(): ReadableSpan {
    const spans = exporter.getFinishedSpans();
    // expected exactly one llm_tool_result span
    expect(spans.length).toEqual(1);
    const span = spans[0]!;
    expect(span.name).toEqual("llm_tool_result");
    return span;
  }

  test("test_captures_tool_result_attributes", async () => {
    // The call_id, function name, and result payload land on the span.
    //
    // These are passed positionally, exactly as the real service calls
    // `_toolResult(toolCallId, toolName, toolResultMessage)`.
    const service = new _StubGeminiLiveService();

    await service._toolResult("call-123", "get_weather", { temperature: 72 });

    const attrs = _toolResultSpan().attributes;
    expect(attrs["tool.call_id"]).toEqual("call-123");
    expect(attrs["tool.function_name"]).toEqual("get_weather");
    expect(attrs["tool.result"] as string).toContain('"temperature": 72');
    expect(attrs["tool.result_status"]).toEqual("completed");
  });

  test("test_result_status_error", async () => {
    // An `error` key in the result dict marks the span as errored.
    const service = new _StubGeminiLiveService();

    await service._toolResult("call-err", "lookup", { error: "not found" });

    expect(_toolResultSpan().attributes["tool.result_status"]).toEqual("error");
  });

  test("test_result_status_success", async () => {
    // A `success` key in the result dict marks the span as succeeded.
    const service = new _StubGeminiLiveService();

    await service._toolResult("call-ok", "lookup", { success: true, value: 1 });

    expect(_toolResultSpan().attributes["tool.result_status"]).toEqual("success");
  });

  test("test_long_result_is_truncated", async () => {
    // Result payloads over the 2000-char limit are truncated with an ellipsis.
    const service = new _StubGeminiLiveService();

    await service._toolResult("call-big", "dump", { blob: "x".repeat(5000) });

    const result = _toolResultSpan().attributes["tool.result"] as string;
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(2003);
  });

  test("test_non_dict_result_omits_result_attribute", async () => {
    // A non-dict result still records call_id/name but no result payload.
    const service = new _StubGeminiLiveService();

    await service._toolResult("call-str", "echo", "just a string");

    const attrs = _toolResultSpan().attributes;
    expect(attrs["tool.call_id"]).toEqual("call-str");
    expect(attrs["tool.function_name"]).toEqual("echo");
    expect(attrs).not.toHaveProperty("tool.result");
    expect(attrs).not.toHaveProperty("tool.result_status");
  });
});
