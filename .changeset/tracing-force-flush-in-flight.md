---
"@pipedog/tracing": patch
---

`forceFlushTracing()` now also waits for the span exports already in flight. The SDK's `BatchSpanProcessor.forceFlush()` returns at once when its timer has just started an export, so spans could still be on their way to the collector (or lost, when a Workers request ended) after the flush.
