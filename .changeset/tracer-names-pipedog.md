---
"@pipedog/core": minor
"@pipedog/tracing": minor
---

Traces say pipedog now. The library's tracers are called `pipedog` and `pipedog.turn` (they were
`pipecat` and `pipecat.turn`, as upstream), and `setupTracing()` defaults `service.name` to
`"pipedog"` (was `"pipecat"`). Span names and attribute keys are unchanged.

If a dashboard, alert or query filters on the Pipecat tracer names, bring them back at startup,
before creating a pipeline, with `setTracerName("pipecat")` or `setupTracing({ tracerName:
"pipecat" })`. `getTracerName()` and `DEFAULT_TRACER_NAME` are exported too. Set your own
`serviceName` in production either way.
