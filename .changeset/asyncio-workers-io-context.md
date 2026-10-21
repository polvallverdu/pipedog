---
"@pipedog/asyncio": patch
---

On Cloudflare Workers, loop callbacks run in the I/O context that scheduled them. One isolate
serves many requests and Durable Objects, and the shared ready queue could run one session's
callbacks during another's turn, so its I/O failed with "Cannot perform I/O on behalf of a
different Durable Object" (or "request"), and tasks those callbacks created stayed in the wrong
context. Parallel voice sessions on Durable Objects could lose their speech-to-text connection or
their WebSocket output this way.
