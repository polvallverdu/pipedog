// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  EndFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { IdentityFilter } from "@pipedog/core/processors/filters/identity_filter";
import {
  getOpenTelemetry,
  isTracingAvailable,
  type OpenTelemetryModules,
  registerOpenTelemetry,
} from "@pipedog/core/utils/tracing/setup";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import {
  DEFAULT_TRACER_NAME,
  forceFlushTracing,
  getTracerName,
  InMemorySpanExporter,
  OTLPTraceExporter,
  SimpleSpanProcessor,
  setTracerName,
  setupTracing,
  shutdownTracing,
} from "../src/index.ts";

describe("setupTracing", () => {
  const exporter = new InMemorySpanExporter();
  let previous: OpenTelemetryModules | null = null;

  beforeAll(() => {
    previous = getOpenTelemetry();
  });

  afterAll(() => {
    // The global tracer provider stays (it can only be set once per process).
    registerOpenTelemetry(previous);
  });

  test("registers OpenTelemetry with core and sets the global provider", async () => {
    expect(setupTracing({ serviceName: "pipedog-test", exporter })).toBe(true);
    expect(isTracingAvailable()).toBe(true);
    expect(getOpenTelemetry()?.sdk).toBeDefined();
    expect(getOpenTelemetry()?.resources).toBeDefined();

    const span = trace.getTracer("test").startSpan("probe");
    span.end();
    await forceFlushTracing();
    const probe = exporter.getFinishedSpans().find((s) => s.name === "probe");
    expect(probe).toBeDefined();
    expect(probe!.resource.attributes["service.name"]).toBe("pipedog-test");
    expect(probe!.resource.attributes["deployment.environment"]).toBeDefined();
    expect(probe!.resource.attributes["service.instance.id"]).toBeDefined();
    exporter.reset();
  });

  /** Run one short conversation through a traced pipeline, and flush its spans. */
  async function runConversation(conversationId: string, attributes: Record<string, string> = {}) {
    const worker = new PipelineWorker(new Pipeline([new IdentityFilter()]), {
      enableTracing: true,
      conversationId,
      additionalSpanAttributes: attributes,
      cancelOnIdleTimeout: false,
    });
    const runner = new WorkerRunner();
    await runner.addWorkers(worker);
    worker.eventHandler("on_pipeline_started", async () => {
      for (const frame of [
        new UserStartedSpeakingFrame(),
        new UserStoppedSpeakingFrame(),
        new BotStartedSpeakingFrame(),
        new BotStoppedSpeakingFrame(),
      ]) {
        await worker.queueFrame(frame);
      }
      // Ending the pipeline ends the turn and the conversation.
      await worker.queueFrame(new EndFrame());
    });
    await runner.run();
    await forceFlushTracing();
  }

  test("the tracers are called pipedog by default, and pipecat once asked for", async () => {
    expect(getTracerName()).toBe(DEFAULT_TRACER_NAME);
    expect(DEFAULT_TRACER_NAME).toBe("pipedog");
    exporter.reset();
    await runConversation("conv-default-names");
    const names = new Set(exporter.getFinishedSpans().map((s) => s.instrumentationScope.name));
    expect([...names]).toEqual(["pipedog.turn"]);

    // For dashboards and queries that filter on upstream's names.
    setTracerName("pipecat");
    try {
      exporter.reset();
      await runConversation("conv-upstream-names");
      const upstream = new Set(exporter.getFinishedSpans().map((s) => s.instrumentationScope.name));
      expect([...upstream]).toEqual(["pipecat.turn"]);
    } finally {
      setTracerName(DEFAULT_TRACER_NAME);
    }
    exporter.reset();
  });

  test("setupTracing({ tracerName }) sets it, and an empty name is refused", () => {
    try {
      setupTracing({ exporter, tracerName: "custom" });
      expect(getTracerName()).toBe("custom");
    } finally {
      setTracerName(DEFAULT_TRACER_NAME);
    }
    expect(() => setTracerName("")).toThrow();
    expect(getTracerName()).toBe(DEFAULT_TRACER_NAME);
  });

  test("a PipelineWorker with enableTracing exports conversation and turn spans", async () => {
    await runConversation("conv-e2e", { "app.tenant": "acme" });

    const spans = exporter.getFinishedSpans();
    const conversation = spans.find((s) => s.name === "conversation");
    const turn = spans.find((s) => s.name === "turn");
    expect(conversation).toBeDefined();
    expect(turn).toBeDefined();
    expect(conversation!.attributes["conversation.id"]).toBe("conv-e2e");
    expect(conversation!.attributes["conversation.type"]).toBe("voice");
    expect(conversation!.attributes["app.tenant"]).toBe("acme");
    expect(turn!.attributes["turn.number"]).toBe(1);
    expect(turn!.attributes["turn.type"]).toBe("conversation");
    expect(turn!.attributes["conversation.id"]).toBe("conv-e2e");
    expect(typeof turn!.attributes["turn.duration_seconds"]).toBe("number");
    expect(turn!.parentSpanContext?.spanId).toBe(conversation!.spanContext().spanId);
    expect(turn!.spanContext().traceId).toBe(conversation!.spanContext().traceId);
  });
});

describe("OTLPTraceExporter", () => {
  test("exports OTLP/HTTP JSON to a collector", async () => {
    const received: any[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          type: request.headers.get("content-type"),
          body: await request.json(),
        });
        return Response.json({});
      },
    });
    try {
      // A provider of its own: the global one belongs to the test above.
      const provider = new BasicTracerProvider({
        spanProcessors: [
          new SimpleSpanProcessor(
            new OTLPTraceExporter({ url: `http://127.0.0.1:${server.port}/v1/traces` }),
          ),
        ],
      });
      const span = provider.getTracer("pipecat").startSpan("tts");
      span.setAttribute("gen_ai.operation.name", "text_to_speech");
      span.end();
      await provider.forceFlush();
      await provider.shutdown();

      expect(received.length).toBe(1);
      expect(received[0].path).toBe("/v1/traces");
      expect(received[0].type).toBe("application/json");
      const spans = received[0].body.resourceSpans[0].scopeSpans[0].spans;
      expect(spans[0].name).toBe("tts");
      expect(spans[0].attributes).toContainEqual({
        key: "gen_ai.operation.name",
        value: { stringValue: "text_to_speech" },
      });
    } finally {
      server.stop(true);
    }
  });
});

describe("forceFlushTracing", () => {
  test("waits for an export the batch timer started before the call", async () => {
    // Exports take 150 ms to reach the "collector".
    class SlowExporter extends InMemorySpanExporter {
      override export(
        spans: Parameters<InMemorySpanExporter["export"]>[0],
        callback: Parameters<InMemorySpanExporter["export"]>[1],
      ) {
        setTimeout(() => super.export(spans, callback), 150);
      }
    }
    const exporter = new SlowExporter();
    const previous = process.env.OTEL_BSP_SCHEDULE_DELAY;
    process.env.OTEL_BSP_SCHEDULE_DELAY = "20";
    trace.disable();
    try {
      expect(setupTracing({ serviceName: "pipedog-slow", exporter })).toBe(true);
      trace.getTracer("test").startSpan("late").end();
      // The 20 ms timer starts the export: the span has left the processor's queue.
      await new Promise((resolve) => setTimeout(resolve, 60));
      await forceFlushTracing();
      expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["late"]);
    } finally {
      if (previous === undefined) delete process.env.OTEL_BSP_SCHEDULE_DELAY;
      else process.env.OTEL_BSP_SCHEDULE_DELAY = previous;
      await shutdownTracing();
      trace.disable();
    }
  });
});
