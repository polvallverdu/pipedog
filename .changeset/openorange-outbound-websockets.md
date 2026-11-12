---
"@pipedog/core": patch
"@pipedog/transport-websocket": patch
"@pipedog/asyncio": patch
---

Voice agents built for Cloudflare Workers now run on OpenOrange, which runs Workers projects on
Node.js. Outbound WebSockets on Workers are opened with `fetch()` and an `Upgrade` header, which
OpenOrange's `fetch` rejects; pipedog now falls back to the `WebSocket` constructor there, which
sends the same headers. `waitFor` on an already-running promise that rejects before its task
starts no longer reports the rejection as unhandled (Node exits on that by default).
