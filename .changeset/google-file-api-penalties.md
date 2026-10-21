---
"@pipedog/google": patch
"@pipedog/core": patch
"@pipedog/openai": patch
"@pipedog/transport-websocket": patch
---

`GoogleLLMService` sends `frequencyPenalty` and `presencePenalty` when they are set.
`GeminiFileAPI.uploadFile()` takes the file's contents (a `Uint8Array`, an `ArrayBuffer`, a
`Blob` or a `ReadableStream`, with an optional `mimeType`) as well as a path, so uploads work on
Cloudflare Workers. A path on a runtime without `node:fs` throws an error that says what to pass
instead. `GeminiLiveLLMService` logs a warning when it drops an `LLMSetToolsFrame`. Comments and
docs now say that WebSocket auth headers are sent on Cloudflare Workers.
