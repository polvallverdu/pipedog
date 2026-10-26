# @pipedog/tracing

OpenTelemetry setup for pipedog. `@pipedog/core` already holds the port of Pipecat's tracing (the
conversation and turn spans, and the `stt`, `llm` and `tts` service spans) and needs only
`@opentelemetry/api`. This package adds what upstream's `pipecat-ai[tracing]` extra brings in: the
OpenTelemetry SDK, an OTLP/HTTP exporter, and `setupTracing()`.

A port of Pipecat's `pipecat.utils.tracing.setup` (`setup_tracing(service_name, exporter,
console_export)` becomes `setupTracing({ serviceName, exporter, consoleExport })`).

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/tracing @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency (`^1.3.0`), so the app and core share one copy.

## Usage

```ts
import { OTLPTraceExporter, setupTracing } from "@pipedog/tracing";

setupTracing({
  serviceName: "my-voice-bot",
  exporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
});
// then: new PipelineWorker(pipeline, { enableTracing: true })
```

`forceFlushTracing()` and `shutdownTracing()` flush and stop the exporter, for example before a
short-lived process exits.

### Keeping content out of traces

Spans carry what people said (`transcript`, `text`, `input`, `output`, ...). `redactContent` keeps
timings, ids, numbers and booleans, and drops string attributes unless their key is allowed (model,
provider, voice, language, conversation and turn ids by default), plus event, exception and status
details:

```ts
setupTracing({ serviceName: "my-voice-bot", exporter, redactContent: true });
// or { redactContent: { extraAllowedAttributes: ["app.tenant"] } }
// with your own OpenTelemetry setup: registerWithCore({ redactContent: true })
```

`redactTracer`, `redactTracerProvider` and `redactSpan` apply the same rules to your own spans.

### Names

Span names and attribute keys are Pipecat's. The library's tracers are called `pipedog` and
`pipedog.turn` (Pipecat: `pipecat` and `pipecat.turn`), and the default `service.name` is
`"pipedog"`, so set your own `serviceName`. If a dashboard or query filters on Pipecat's tracer
names, bring them back at startup, before creating a pipeline:

```ts
import { setTracerName } from "@pipedog/tracing";

setTracerName("pipecat"); // or setupTracing({ tracerName: "pipecat", ... })
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers. On Workers, flush before the request ends; the docs
show how.

## Links

- Docs: [metrics and tracing](https://polvallverdu.github.io/pipedog/docs/concepts/metrics-and-tracing/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
