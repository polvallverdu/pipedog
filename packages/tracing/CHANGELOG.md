# @pipedog/tracing

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0

## 0.7.0

### Minor Changes

- [#68](https://github.com/polvallverdu/pipedog/pull/68) [`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Traces say pipedog now. The library's tracers are called `pipedog` and `pipedog.turn` (they were
  `pipecat` and `pipecat.turn`, as upstream), and `setupTracing()` defaults `service.name` to
  `"pipedog"` (was `"pipecat"`). Span names and attribute keys are unchanged.
  
  If a dashboard, alert or query filters on the Pipecat tracer names, bring them back at startup,
  before creating a pipeline, with `setTracerName("pipecat")` or `setupTracing({ tracerName:
  "pipecat" })`. `getTracerName()` and `DEFAULT_TRACER_NAME` are exported too. Set your own
  `serviceName` in production either way.

### Patch Changes

- [#66](https://github.com/polvallverdu/pipedog/pull/66) [`dabec71`](https://github.com/polvallverdu/pipedog/commit/dabec71b7d5796055f09830335d550448fffb00d) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `forceFlushTracing()` now also waits for the span exports already in flight. The SDK's `BatchSpanProcessor.forceFlush()` returns at once when its timer has just started an export, so spans could still be on their way to the collector (or lost, when a Workers request ended) after the flush.
- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies []:
  - @pipedog/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/core@0.6.0

## 0.5.0

### Patch Changes

- [#20](https://github.com/polvallverdu/pipedog/pull/20) [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Package READMEs on npm. `@pipedog/core`, `@pipedog/asyncio`, `@pipedog/openai`,
  `@pipedog/anthropic`, `@pipedog/deepgram`, `@pipedog/cartesia`, `@pipedog/elevenlabs`,
  `@pipedog/tracing` and `@pipedog/whisper` now ship a README with install steps, a usage snippet,
  runtimes and links to the docs. Every package gains npm `keywords`, and the `@pipedog/elevenlabs`
  description no longer lists Text-to-Dialogue, which is not ported yet.
- Updated dependencies [[`70dce6f`](https://github.com/polvallverdu/pipedog/commit/70dce6fcf5ffefa49ef2c21f87bac6377f0d5a09), [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301)]:
  - @pipedog/core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`b88231a`](https://github.com/polvallverdu/pipedog/commit/b88231af79d984e191b54c30965fa062a60ec8c3)]:
  - @pipedog/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`6aa3dac`](https://github.com/polvallverdu/pipedog/commit/6aa3dacb45a967e7bc147ab2905b9d8a808fa8c0)]:
  - @pipedog/core@0.3.0

## 0.2.0

### Minor Changes

- [#6](https://github.com/polvallverdu/pipedog/pull/6) [`72b8cb8`](https://github.com/polvallverdu/pipedog/commit/72b8cb82b807d7b194f525872bc0ac662a9df3dc) Thanks [@polvallverdu](https://github.com/polvallverdu)! - OpenTelemetry tracing, as in Pipecat's `pipecat-ai[tracing]` extra, on Bun, Node, Deno and Cloudflare Workers.
  
  `@pipedog/core`: `@opentelemetry/api` is now an optional peer dependency. When it is installed, core imports it on its own (a dynamic `import()` started when `utils/tracing/setup` loads, with no top-level await), and `isTracingAvailable()` turns true, like upstream's `is_tracing_available()`. Without it, core runs as before and tracing stays a no-op. `PipelineWorker` awaits that import in its async setup before deciding whether to trace, so construction order does not matter (a worker built at module top level traces too); `loadOpenTelemetry()` exposes the same wait. `registerOpenTelemetry()` still registers the modules explicitly and now wins over the automatic import. The structural OpenTelemetry types accept the real `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` modules (array attribute values may hold `null`/`undefined`, as in OpenTelemetry). Span names, attributes and hierarchy are unchanged and match upstream's.
  
  `@pipedog/tracing` (new): `setupTracing({ serviceName, exporter, consoleExport })`, matching upstream's `setup_tracing()`: it registers `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` and `@opentelemetry/resources` with core and installs a global tracer provider with batch span processors for the given exporter and, optionally, the console. It re-exports `OTLPTraceExporter` (OTLP/HTTP JSON, from `@opentelemetry/exporter-trace-otlp-http`), `ConsoleSpanExporter`, `InMemorySpanExporter` and the span processors. `forceFlushTracing()` and `shutdownTracing()` export what the batch processors still hold, e.g. `ctx.waitUntil(forceFlushTracing())` on Cloudflare Workers. `@opentelemetry/api` is a peer dependency.

### Patch Changes

- Updated dependencies [[`122b72f`](https://github.com/polvallverdu/pipedog/commit/122b72fb4167cf2b12112d83de5ed255c9e0d897), [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3), [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3), [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3), [`72b8cb8`](https://github.com/polvallverdu/pipedog/commit/72b8cb82b807d7b194f525872bc0ac662a9df3dc), [`72b8cb8`](https://github.com/polvallverdu/pipedog/commit/72b8cb82b807d7b194f525872bc0ac662a9df3dc)]:
  - @pipedog/core@0.2.0
