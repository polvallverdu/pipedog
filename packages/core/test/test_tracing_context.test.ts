// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_tracing_context.py

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  getOpenTelemetry,
  type OpenTelemetryModules,
  type OtelApi,
  type OtelTracer,
  registerOpenTelemetry,
} from "../src/utils/tracing/setup.ts";
import { TracingContext } from "../src/utils/tracing/tracing_context.ts";

// Upstream skips the suite unless opentelemetry is installed. Core does not
// depend on OpenTelemetry, so the modules are loaded optionally here.
// Module names are held in variables so TypeScript does not require them.
const OTEL_API = "@opentelemetry/api";
const OTEL_SDK = "@opentelemetry/sdk-trace-base";

interface OtelSdk {
  BasicTracerProvider: new (
    config?: Record<string, unknown>,
  ) => {
    getTracer(name: string): OtelTracer;
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

/** Tests for TracingContext. */
describe.skipIf(!HAS_OPENTELEMETRY)("TestTracingContext", () => {
  let tracer: OtelTracer;
  let previous: OpenTelemetryModules | null = null;

  // Set up a tracer provider for generating span contexts.
  beforeAll(() => {
    previous = getOpenTelemetry();
    // Upstream's is_tracing_available() is true whenever opentelemetry imports.
    registerOpenTelemetry({ api: api as OtelApi });
    const provider = new (sdk as OtelSdk).BasicTracerProvider();
    tracer = provider.getTracer("test");
  });

  afterAll(() => {
    registerOpenTelemetry(previous);
  });

  test("test_initial_state_is_empty", () => {
    // Test that a new TracingContext starts with no context set.
    const ctx = new TracingContext();
    expect(ctx.getConversationContext()).toBeNull();
    expect(ctx.getTurnContext()).toBeNull();
    expect(ctx.conversationId).toBeNull();
  });

  test("test_set_and_get_conversation_context", () => {
    // Test setting and retrieving conversation context.
    const ctx = new TracingContext();
    const span = tracer.startSpan("conv");
    const spanContext = span.spanContext();

    ctx.setConversationContext(spanContext, "conv-123");

    expect(ctx.getConversationContext()).not.toBeNull();
    expect(ctx.conversationId).toEqual("conv-123");
    span.end();
  });

  test("test_clear_conversation_context", () => {
    // Test clearing conversation context by passing null.
    const ctx = new TracingContext();
    const span = tracer.startSpan("conv");

    ctx.setConversationContext(span.spanContext(), "conv-123");
    expect(ctx.getConversationContext()).not.toBeNull();

    ctx.setConversationContext(null);
    expect(ctx.getConversationContext()).toBeNull();
    expect(ctx.conversationId).toBeNull();
    span.end();
  });

  test("test_set_and_get_turn_context", () => {
    // Test setting and retrieving turn context.
    const ctx = new TracingContext();
    const span = tracer.startSpan("turn");
    const spanContext = span.spanContext();

    ctx.setTurnContext(spanContext);

    expect(ctx.getTurnContext()).not.toBeNull();
    span.end();
  });

  test("test_clear_turn_context", () => {
    // Test clearing turn context by passing null.
    const ctx = new TracingContext();
    const span = tracer.startSpan("turn");

    ctx.setTurnContext(span.spanContext());
    expect(ctx.getTurnContext()).not.toBeNull();

    ctx.setTurnContext(null);
    expect(ctx.getTurnContext()).toBeNull();
    span.end();
  });

  test("test_generate_conversation_id", () => {
    // Test that generated conversation IDs are unique UUIDs.
    const id1 = TracingContext.generateConversationId();
    const id2 = TracingContext.generateConversationId();
    expect(typeof id1).toBe("string");
    expect(id1).not.toEqual(id2);
  });

  test("test_instances_are_isolated", () => {
    // Test that two TracingContext instances do not share state.
    const ctxA = new TracingContext();
    const ctxB = new TracingContext();

    const span = tracer.startSpan("turn");

    ctxA.setTurnContext(span.spanContext());
    ctxA.setConversationContext(span.spanContext(), "conv-a");

    // ctx_b should still be empty
    expect(ctxB.getTurnContext()).toBeNull();
    expect(ctxB.getConversationContext()).toBeNull();
    expect(ctxB.conversationId).toBeNull();
    span.end();
  });

  test("test_conversation_and_turn_are_independent", () => {
    // Test that clearing turn context does not affect conversation context.
    const ctx = new TracingContext();
    const convSpan = tracer.startSpan("conv");
    const turnSpan = tracer.startSpan("turn");

    ctx.setConversationContext(convSpan.spanContext(), "conv-1");
    ctx.setTurnContext(turnSpan.spanContext());

    // Clear turn but conversation should remain
    ctx.setTurnContext(null);
    expect(ctx.getTurnContext()).toBeNull();
    expect(ctx.getConversationContext()).not.toBeNull();
    expect(ctx.conversationId).toEqual("conv-1");

    convSpan.end();
    turnSpan.end();
  });
});
