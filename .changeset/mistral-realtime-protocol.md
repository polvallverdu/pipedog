---
"@pipedog/mistral": patch
---

`MistralSTTService` now speaks Mistral's realtime protocol as the SDK does: it waits for
`session.created` before sending `session.update`, and sends `targetStreamingDelayMs` as the
session's `target_streaming_delay_ms` instead of a query parameter. `error` events whose message is
an object are reported in full.
