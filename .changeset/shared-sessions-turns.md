---
"@pipedog/onnx": minor
"@pipedog/audio-silero": minor
"@pipedog/audio-smart-turn": minor
"@pipedog/core": minor
"@pipedog/transport-websocket": minor
---

Lighter sessions, working default turn detection, and WebSockets with headers on Workers.

- `@pipedog/onnx`: `sharedSession(backend, model, options)` shares one inference session per
  backend, model and options; runs are serialized on onnxruntime-web. `disposeSharedSessions()`
  releases them.
- `@pipedog/audio-silero`, `@pipedog/audio-smart-turn`: analyzers share their session by default
  (`shareSession: false` opts out). Each further call now costs about 1.3 MB instead of about 52 MB.
- `@pipedog/core`: `LocalSmartTurnAnalyzerV3` without `createSession` loads
  `@pipedog/audio-smart-turn` when it's installed, on first use. Without it, turns end on the VAD's
  silence, with one warning, instead of failing. On Cloudflare Workers, service websockets connect
  with `fetch()`, so their auth headers are sent. Warning and error logs mask credentials in their
  message and attached error, for every sink.
- `@pipedog/transport-websocket`: `websocketConnect` on Workers connects with `fetch()` and sends
  `additionalHeaders`.
