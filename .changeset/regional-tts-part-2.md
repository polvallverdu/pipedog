---
"@pipedog/neuphonic": minor
"@pipedog/speechify": minor
"@pipedog/minimax": minor
"@pipedog/resembleai": minor
"@pipedog/camb": minor
"@pipedog/asyncai": minor
"@pipedog/bland": minor
---

Seven more text-to-speech providers, each in its own package.

- `@pipedog/neuphonic` (new): `NeuphonicTTSService` over WebSocket and `NeuphonicHttpTTSService` over server-sent events.
- `@pipedog/speechify` (new): `SpeechifyHttpTTSService`, streaming audio and word timestamps over server-sent events.
- `@pipedog/minimax` (new): `MiniMaxHttpTTSService`, MiniMax's T2A streaming API.
- `@pipedog/resembleai` (new): `ResembleAITTSService` over WebSocket, with word timestamps.
- `@pipedog/camb` (new): `CambTTSService` for the MARS models. It calls Camb's streaming endpoint with `fetch`, in place of the Python SDK.
- `@pipedog/asyncai` (new): `AsyncAITTSService` over WebSocket and `AsyncAIHttpTTSService` over HTTP.
- `@pipedog/bland` (new): `BlandTTSService` over Bland's realtime WebSocket (LLM tokens streamed, barge-in as `cancel`) and `BlandHttpTTSService`.

All of them use `fetch` and core's `websocketConnect`, so they run on Bun, Node, Deno and Cloudflare Workers. They were tested against local fake servers, not the real services. The upstream tests are ported (Speechify, MiniMax, Resemble AI, Async, Bland), and Neuphonic and Camb, which have none upstream, have their own.
