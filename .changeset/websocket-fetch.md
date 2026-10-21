---
"@pipedog/transport-websocket": minor
---

WebSocket endpoints as fetch handlers. `websocketFetchHandler(onConnection)` returns a
`(Request) => Promise<Response>` for runtimes that upgrade from fetch: Cloudflare Workers and
Durable Objects (`WebSocketPair`), and Deno (`Deno.upgradeWebSocket`). Each connection goes to
`onConnection` as a `WebsocketConnection`. A request that isn't an upgrade gets `426`.
`upgradeWebSocket(request)` is the lower-level helper.
