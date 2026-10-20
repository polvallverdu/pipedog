// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: tests/test_turn_trace_observer.py

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../src/frames/frames.ts";
import type { BaseObserver } from "../src/observers/base_observer.ts";
import { TurnTrackingObserver } from "../src/observers/turn_tracking_observer.ts";
import { UserBotLatencyObserver } from "../src/observers/user_bot_latency_observer.ts";
import { IdentityFilter } from "../src/processors/filters/identity_filter.ts";
import { runTest, SleepFrame } from "../src/tests/utils.ts";
import {
  getOpenTelemetry,
  type OpenTelemetryModules,
  type OtelApi,
  type OtelTracer,
  registerOpenTelemetry,
} from "../src/utils/tracing/setup.ts";
import { TracingContext } from "../src/utils/tracing/tracing_context.ts";
import { TurnTraceObserver } from "../src/utils/tracing/turn_trace_observer.ts";

// Upstream skips the suite unless opentelemetry is installed. `@opentelemetry/api`
// is an optional peer of core; it and `@opentelemetry/sdk-trace-base` are core
// devDependencies, so the suite runs here. They are still loaded optionally, as
// upstream does (module names in variables keep TypeScript from requiring them).
const OTEL_API = "@opentelemetry/api";
const OTEL_SDK = "@opentelemetry/sdk-trace-base";

interface SpanContextLike {
  spanId: string;
}

interface ReadableSpan {
  name: string;
  attributes: Record<string, unknown>;
  spanContext(): SpanContextLike;
  /** sdk-trace-base v2. */
  parentSpanContext?: SpanContextLike;
  /** sdk-trace-base v1. */
  parentSpanId?: string;
}

interface InMemorySpanExporter {
  getFinishedSpans(): ReadableSpan[];
  reset(): void;
}

interface TracerProvider {
  getTracer(name: string, version?: string): OtelTracer;
  shutdown(): Promise<void>;
}

interface OtelSdk {
  BasicTracerProvider: new (config?: Record<string, unknown>) => TracerProvider;
  SimpleSpanProcessor: new (exporter: unknown) => unknown;
  InMemorySpanExporter: new () => InMemorySpanExporter;
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

// Test-only access to the observer's protected members.
const internals = (o: TurnTraceObserver): any => o;

/** The parent span id of a finished span (works with sdk-trace-base v1 and v2). */
function parentSpanId(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId ?? span.parentSpanId;
}

/** Tests for TurnTraceObserver. */
describe.skipIf(!HAS_OPENTELEMETRY)("TestTurnTraceObserver", () => {
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;
  let tracer: OtelTracer;
  let previous: OpenTelemetryModules | null = null;

  // Upstream's is_tracing_available() is true whenever opentelemetry imports.
  beforeAll(() => {
    previous = getOpenTelemetry();
    registerOpenTelemetry({ api: api as OtelApi });
  });

  afterAll(() => {
    registerOpenTelemetry(previous);
  });

  // Set up a fresh provider and exporter for each test.
  //
  // We create a dedicated TracerProvider per test and inject its tracer
  // directly into the observer, avoiding the global provider singleton.
  beforeEach(() => {
    const otelSdk = sdk as OtelSdk;
    exporter = new otelSdk.InMemorySpanExporter();
    provider = new otelSdk.BasicTracerProvider({
      spanProcessors: [new otelSdk.SimpleSpanProcessor(exporter)],
    });
    tracer = provider.getTracer("pipecat.turn");
  });

  // Shut down the provider to flush spans.
  afterEach(async () => {
    await provider.shutdown();
  });

  /**
   * Create a standard set of turn/trace observers.
   *
   * @returns Tuple of [turnTracker, latencyTracker, traceObserver, tracingContext].
   */
  function _createObservers(
    options: { conversationId?: string | null; tracingContext?: TracingContext | null } = {},
  ): [TurnTrackingObserver, UserBotLatencyObserver, TurnTraceObserver, TracingContext] {
    const tracingContext = options.tracingContext || new TracingContext();
    const turnTracker = new TurnTrackingObserver({ turnEndTimeoutSecs: 0.2 });
    const latencyTracker = new UserBotLatencyObserver();
    const traceObserver = new TurnTraceObserver({
      turnTracker,
      latencyTracker,
      conversationId: options.conversationId ?? null,
      tracingContext,
    });
    // Inject the test tracer so spans go to our in-memory exporter
    internals(traceObserver)._tracer = tracer;
    return [turnTracker, latencyTracker, traceObserver, tracingContext];
  }

  /** Return the list of observers needed for runTest. */
  function _allObservers(traceObserver: TurnTraceObserver): BaseObserver[] {
    return [
      internals(traceObserver)._turnTracker,
      internals(traceObserver)._latencyTracker,
      traceObserver,
    ];
  }

  /** Return finished spans with the given name. */
  function _getSpansByName(name: string): ReadableSpan[] {
    return exporter.getFinishedSpans().filter((s) => s.name === name);
  }

  test("test_conversation_span_created_on_start_frame", async () => {
    // Test that a conversation span is created when StartFrame is observed.
    const [, , traceObserver] = _createObservers({ conversationId: "test-conv" });
    const processor = new IdentityFilter();

    const framesToSend = [
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }),
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: _allObservers(traceObserver),
    });

    // End conversation to flush the conversation span (normally done by PipelineWorker._cleanup)
    traceObserver.endConversationTracing();

    const convSpans = _getSpansByName("conversation");
    expect(convSpans.length).toEqual(1);
    expect(convSpans[0]!.attributes["conversation.id"]).toEqual("test-conv");
    expect(convSpans[0]!.attributes["conversation.type"]).toEqual("voice");
  });

  test("test_turn_spans_created_for_each_turn", async () => {
    // Test that a turn span is created for each conversation turn.
    const [, , traceObserver] = _createObservers();
    const processor = new IdentityFilter();

    const framesToSend = [
      // Turn 1
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.05 }),
      // Turn 2
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }),
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: _allObservers(traceObserver),
    });

    const turnSpans = _getSpansByName("turn");
    expect(turnSpans.length).toEqual(2);
    const turnNumbers = new Set(turnSpans.map((s) => s.attributes["turn.number"]));
    expect(turnNumbers).toEqual(new Set([1, 2]));
  });

  test("test_turn_spans_are_children_of_conversation", async () => {
    // Test that turn spans are parented under the conversation span.
    const [, , traceObserver] = _createObservers();
    const processor = new IdentityFilter();

    const framesToSend = [
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }),
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: _allObservers(traceObserver),
    });

    // End conversation to flush the conversation span
    traceObserver.endConversationTracing();

    const convSpans = _getSpansByName("conversation");
    const turnSpans = _getSpansByName("turn");
    expect(convSpans.length).toEqual(1);
    expect(turnSpans.length).toEqual(1);

    // Turn span's parent should be the conversation span
    const convSpanId = convSpans[0]!.spanContext().spanId;
    const turnParentId = parentSpanId(turnSpans[0]!);
    expect(turnParentId).toEqual(convSpanId);
  });

  test("test_interrupted_turn_marked", async () => {
    // Test that an interrupted turn span has was_interrupted=True.
    const [, , traceObserver] = _createObservers();
    const processor = new IdentityFilter();

    const framesToSend = [
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      // User interrupts
      new UserStartedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }),
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      UserStartedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: _allObservers(traceObserver),
    });

    // End conversation to flush remaining spans
    traceObserver.endConversationTracing();

    const turnSpans = _getSpansByName("turn");
    expect(turnSpans.length).toBeGreaterThanOrEqual(1);
    // First turn should be interrupted
    const interruptedTurns = turnSpans.filter((s) => s.attributes["turn.was_interrupted"]);
    expect(interruptedTurns.length).toBeGreaterThanOrEqual(1);
  });

  test("test_tracing_context_updated_during_turn", async () => {
    // Test that TracingContext is populated during a turn and cleared after.
    const tracingCtx = new TracingContext();
    const [, , traceObserver] = _createObservers({ tracingContext: tracingCtx });
    const processor = new IdentityFilter();

    const framesToSend = [
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }),
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: _allObservers(traceObserver),
    });

    // After the turn ends, turn context should be cleared
    expect(tracingCtx.getTurnContext()).toBeNull();
  });

  test("test_tracing_context_cleared_after_conversation_end", async () => {
    // Test that TracingContext is cleared when conversation tracing ends.
    const tracingCtx = new TracingContext();
    const [, , traceObserver] = _createObservers({ tracingContext: tracingCtx });
    const processor = new IdentityFilter();

    const framesToSend = [
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }),
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: _allObservers(traceObserver),
    });

    // Manually end conversation tracing (as PipelineWorker._cleanup does)
    traceObserver.endConversationTracing();

    expect(tracingCtx.getConversationContext()).toBeNull();
    expect(tracingCtx.getTurnContext()).toBeNull();
    expect(tracingCtx.conversationId).toBeNull();
  });

  test("test_additional_span_attributes", async () => {
    // Test that additional span attributes are added to the conversation span.
    const extraAttrs = { "deployment.id": "abc-123", "customer.tier": "premium" };
    const tracingCtx = new TracingContext();
    const turnTracker = new TurnTrackingObserver({ turnEndTimeoutSecs: 0.2 });
    const latencyTracker = new UserBotLatencyObserver();
    const traceObserver = new TurnTraceObserver({
      turnTracker,
      latencyTracker,
      additionalSpanAttributes: extraAttrs,
      tracingContext: tracingCtx,
    });
    internals(traceObserver)._tracer = tracer;
    const processor = new IdentityFilter();

    const framesToSend = [
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }),
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: [turnTracker, latencyTracker, traceObserver],
    });

    // End conversation to flush the conversation span
    traceObserver.endConversationTracing();

    const convSpans = _getSpansByName("conversation");
    expect(convSpans.length).toEqual(1);
    expect(convSpans[0]!.attributes["deployment.id"]).toEqual("abc-123");
    expect(convSpans[0]!.attributes["customer.tier"]).toEqual("premium");
  });

  test("test_concurrent_pipelines_are_isolated", async () => {
    // Test that two pipelines with separate TracingContexts don't interfere.
    const tracingCtxA = new TracingContext();
    const tracingCtxB = new TracingContext();

    const [, , traceObserverA] = _createObservers({
      conversationId: "conv-a",
      tracingContext: tracingCtxA,
    });
    const [, , traceObserverB] = _createObservers({
      conversationId: "conv-b",
      tracingContext: tracingCtxB,
    });

    const processorA = new IdentityFilter();
    const processorB = new IdentityFilter();

    // Upstream shares the same frame instances between both pipelines.
    const frames = [
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }),
    ];

    const expected = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    // Run both pipelines concurrently
    await Promise.all([
      runTest(processorA, {
        framesToSend: frames,
        expectedDownFrames: expected,
        observers: _allObservers(traceObserverA),
      }),
      runTest(processorB, {
        framesToSend: frames,
        expectedDownFrames: expected,
        observers: _allObservers(traceObserverB),
      }),
    ]);

    // End both conversations to flush spans
    traceObserverA.endConversationTracing();
    traceObserverB.endConversationTracing();

    // Each TracingContext should have its own conversation ID
    const convSpans = _getSpansByName("conversation");
    const convIds = new Set(convSpans.map((s) => s.attributes["conversation.id"]));
    expect(convIds).toEqual(new Set(["conv-a", "conv-b"]));

    // Turn spans should be children of their own conversation span, not cross-linked
    const turnSpans = _getSpansByName("turn");
    const convSpanMap = new Map(
      convSpans.map((s) => [s.spanContext().spanId, s.attributes["conversation.id"]]),
    );
    for (const turnSpan of turnSpans) {
      const parentId = parentSpanId(turnSpan);
      const turnConvId = turnSpan.attributes["conversation.id"];
      // Upstream indexes the map directly (KeyError if the parent is unknown).
      expect(convSpanMap.has(parentId as string)).toBe(true);
      const parentConvId = convSpanMap.get(parentId as string);
      // Turn span for {turnConvId} parented under {parentConvId}
      expect(turnConvId).toEqual(parentConvId);
    }
  });

  test("test_end_conversation_closes_active_turn", async () => {
    // Test that endConversationTracing closes any active turn span.
    const [, , traceObserver] = _createObservers();

    // Manually start conversation and a turn
    traceObserver.startConversationTracing("conv-end-test");
    await internals(traceObserver)._handleTurnStarted(1);

    expect(internals(traceObserver)._currentSpan).not.toBeNull();
    expect(internals(traceObserver)._conversationSpan).not.toBeNull();

    // End conversation — should close both turn and conversation
    traceObserver.endConversationTracing();

    expect(internals(traceObserver)._currentSpan).toBeNull();
    expect(internals(traceObserver)._conversationSpan).toBeNull();

    // Check span attributes
    const turnSpans = _getSpansByName("turn");
    expect(turnSpans.length).toEqual(1);
    expect(turnSpans[0]!.attributes["turn.was_interrupted"]).toBe(true);
    expect(turnSpans[0]!.attributes["turn.ended_by_conversation_end"]).toBe(true);
  });

  test("test_conversation_id_auto_generated", async () => {
    // Test that a conversation ID is auto-generated when none is provided.
    const [, , traceObserver] = _createObservers({ conversationId: null });
    const processor = new IdentityFilter();

    const framesToSend = [
      new UserStartedSpeakingFrame(),
      new UserStoppedSpeakingFrame(),
      new BotStartedSpeakingFrame(),
      new BotStoppedSpeakingFrame(),
      new SleepFrame({ sleep: 0.4 }),
    ];

    const expectedDownFrames = [
      UserStartedSpeakingFrame,
      UserStoppedSpeakingFrame,
      BotStartedSpeakingFrame,
      BotStoppedSpeakingFrame,
    ];

    await runTest(processor, {
      framesToSend,
      expectedDownFrames,
      observers: _allObservers(traceObserver),
    });

    // End conversation to flush the conversation span
    traceObserver.endConversationTracing();

    const convSpans = _getSpansByName("conversation");
    expect(convSpans.length).toEqual(1);
    // Should have an auto-generated UUID as conversation.id
    const convId = convSpans[0]!.attributes["conversation.id"] as string;
    expect(convId).not.toBeNull();
    expect(convId).toBeDefined();
    expect(convId.length).toBeGreaterThan(0);
  });
});
