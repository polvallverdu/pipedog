// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for the tracing section of content/docs/concepts/metrics-and-tracing.mdx.
// Type-checked on every docs build.

import * as api from "@opentelemetry/api";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import {
  isTracingAvailable,
  loadOpenTelemetry,
  registerOpenTelemetry,
} from "@pipedog/core/utils/tracing/setup";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { forceFlushTracing, OTLPTraceExporter, setupTracing } from "@pipedog/tracing";

const pipeline = new Pipeline([]);

// #region setup
// Once, at startup (upstream: setup_tracing("my-voice-bot", exporter=...)).
setupTracing({
  serviceName: "my-voice-bot",
  exporter: new OTLPTraceExporter({
    url: "http://localhost:4318/v1/traces", // any OTLP/HTTP collector
  }),
  consoleExport: false, // true also prints every span (debugging)
});

// Then per conversation:
const worker = new PipelineWorker(pipeline, {
  enableTracing: true,
  conversationId: "customer-123", // optional; a UUID otherwise
  additionalSpanAttributes: { "app.tenant": "acme" }, // added to the conversation span
});
// #endregion setup
void worker;

// #region vendors
// Langfuse (OTLP endpoint, Basic auth with your public/secret key pair)
const langfuse = new OTLPTraceExporter({
  url: "https://cloud.langfuse.com/api/public/otel/v1/traces",
  headers: { Authorization: `Basic ${btoa("pk-lf-...:sk-lf-...")}` },
});

// Honeycomb
const honeycomb = new OTLPTraceExporter({
  url: "https://api.honeycomb.io/v1/traces",
  headers: { "x-honeycomb-team": "YOUR_API_KEY" },
});
// #endregion vendors
void langfuse;
void honeycomb;

// #region workers
export default {
  async fetch(_request: Request, _env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const worker = new PipelineWorker(new Pipeline([]), { enableTracing: true });
    const runner = new WorkerRunner({ handleSigint: false });
    await runner.addWorkers(worker);
    await runner.run();
    // Spans are batched: export what is left before the request ends.
    ctx.waitUntil(forceFlushTracing());
    return new Response("ok");
  },
};
// #endregion workers

// #region core-only
// Without @pipedog/tracing: set up the OpenTelemetry SDK your way (it registers
// the global tracer provider), then enable tracing on the worker as usual. Core
// imports @opentelemetry/api on its own.
const traced = new PipelineWorker(pipeline, { enableTracing: true });

// Optional: check whether OpenTelemetry was found...
console.log(await loadOpenTelemetry(), isTracingAvailable());
// ...or hand in a specific copy of the API yourself.
registerOpenTelemetry({ api });
// #endregion core-only
void traced;
