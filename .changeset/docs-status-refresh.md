---
"@pipedog/asyncio": patch
---

README: explain how callbacks are scheduled on Cloudflare Workers (each in the I/O context that
scheduled it), so concurrent Durable Objects don't do each other's I/O.
