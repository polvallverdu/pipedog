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
  forceFlushTracing,
  InMemorySpanExporter,
  OTLPTraceExporter,
  SimpleSpanProcessor,
  setupTracing,
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

  test("a PipelineWorker with enableTracing exports conversation and turn spans", async () => {
    const worker = new PipelineWorker(new Pipeline([new IdentityFilter()]), {
      enableTracing: true,
      conversationId: "conv-e2e",
      additionalSpanAttributes: { "app.tenant": "acme" },
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
