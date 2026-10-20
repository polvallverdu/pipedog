---
"@pipedog/tracing": minor
"@pipedog/core": minor
---

OpenTelemetry tracing, as in Pipecat's `pipecat-ai[tracing]` extra, on Bun, Node, Deno and Cloudflare Workers.

`@pipedog/core`: `@opentelemetry/api` is now an optional peer dependency. When it is installed, core imports it on its own (a dynamic `import()` started when `utils/tracing/setup` loads, with no top-level await), and `isTracingAvailable()` turns true, like upstream's `is_tracing_available()`. Without it, core runs as before and tracing stays a no-op. `loadOpenTelemetry()` waits for that import, for code that builds a `PipelineWorker({ enableTracing: true })` at module top level. `registerOpenTelemetry()` still registers the modules explicitly and now wins over the automatic import. The structural OpenTelemetry types accept the real `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` modules (array attribute values may hold `null`/`undefined`, as in OpenTelemetry). Span names, attributes and hierarchy are unchanged and match upstream's.

`@pipedog/tracing` (new): `setupTracing({ serviceName, exporter, consoleExport })`, matching upstream's `setup_tracing()`: it registers `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` and `@opentelemetry/resources` with core and installs a global tracer provider with batch span processors for the given exporter and, optionally, the console. It re-exports `OTLPTraceExporter` (OTLP/HTTP JSON, from `@opentelemetry/exporter-trace-otlp-http`), `ConsoleSpanExporter`, `InMemorySpanExporter` and the span processors. `forceFlushTracing()` and `shutdownTracing()` export what the batch processors still hold, e.g. `ctx.waitUntil(forceFlushTracing())` on Cloudflare Workers. `@opentelemetry/api` is a peer dependency.
