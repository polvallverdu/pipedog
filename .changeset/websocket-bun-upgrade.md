---
"@pipedog/transport-websocket": patch
---

`websocketFetchHandler` and `upgradeWebSocket` now upgrade on Bun, with the server Bun passes to
`fetch` (`handler(request, server)`, served with the new `bunWebSocket` handlers), and on Node
through the new `serveFetch()`, which serves a fetch handler with WebSocket upgrades on Bun, Node
(with `ws`) and Deno.
