// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Run in its own process by tracing_setup.test.ts. Builds a traced
// PipelineWorker at module top level, before core's asynchronous import of
// @opentelemetry/api can have finished and without registerOpenTelemetry(),
// then runs it and prints the exported spans as JSON.

import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  EndFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "../../src/frames/frames.ts";
import { Pipeline } from "../../src/pipeline/pipeline.ts";
import { PipelineWorker } from "../../src/pipeline/worker.ts";
import { IdentityFilter } from "../../src/processors/filters/identity_filter.ts";
import { isTracingAvailable } from "../../src/utils/tracing/setup.ts";
import { WorkerRunner } from "../../src/workers/runner.ts";

// No await before this point.
const availableAtConstruction = isTracingAvailable();
const worker = new PipelineWorker(new Pipeline([new IdentityFilter()]), {
  enableTracing: true,
  conversationId: "conv-top-level",
  cancelOnIdleTimeout: false,
});

// The app's own SDK setup, through the global provider only.
const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);

worker.eventHandler("on_pipeline_started", async () => {
  for (const frame of [
    new UserStartedSpeakingFrame(),
    new UserStoppedSpeakingFrame(),
    new BotStartedSpeakingFrame(),
    new BotStoppedSpeakingFrame(),
  ]) {
    await worker.queueFrame(frame);
  }
  await worker.queueFrame(new EndFrame());
});
const runner = new WorkerRunner({ handleSigint: false });
await runner.addWorkers(worker);
await runner.run();

const spans = exporter.getFinishedSpans().map((s) => ({
  name: s.name,
  spanId: s.spanContext().spanId,
  parentSpanId: s.parentSpanContext?.spanId ?? null,
  attributes: s.attributes,
}));
process.stdout.write(
  `__RESULT__${JSON.stringify({
    availableAtConstruction,
    hasTurnTraceObserver: worker.turnTraceObserver !== null,
    spans,
  })}\n`,
);
