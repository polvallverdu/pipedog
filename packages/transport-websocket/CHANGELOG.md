# @pipedog/transport-websocket

## 0.11.0

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0
  - @pipedog/serializer-protobuf@0.11.0
  - @pipedog/serializer-rtvi-client@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/serializer-protobuf@0.10.0
  - @pipedog/serializer-rtvi-client@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/serializer-protobuf@0.9.0
  - @pipedog/serializer-rtvi-client@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/serializer-protobuf@0.8.0
  - @pipedog/serializer-rtvi-client@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/serializer-protobuf@0.7.0
  - @pipedog/serializer-rtvi-client@0.7.0
  - @pipedog/asyncio@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1
  - @pipedog/serializer-protobuf@0.6.1
  - @pipedog/serializer-rtvi-client@0.6.1

## 0.6.0

### Patch Changes

- [#40](https://github.com/polvallverdu/pipedog/pull/40) [`626112c`](https://github.com/polvallverdu/pipedog/commit/626112cb7f3974ebc85b4604bbbf42ab38554bdd) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `websocketFetchHandler` and `upgradeWebSocket` now upgrade on Bun, with the server Bun passes to
  `fetch` (`handler(request, server)`, served with the new `bunWebSocket` handlers), and on Node
  through the new `serveFetch()`, which serves a fetch handler with WebSocket upgrades on Bun, Node
  (with `ws`) and Deno.
- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0
  - @pipedog/serializer-protobuf@0.6.0
  - @pipedog/serializer-rtvi-client@0.6.0

## 0.5.0

### Patch Changes

- [#28](https://github.com/polvallverdu/pipedog/pull/28) [`70dce6f`](https://github.com/polvallverdu/pipedog/commit/70dce6fcf5ffefa49ef2c21f87bac6377f0d5a09) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `GoogleLLMService` sends `frequencyPenalty` and `presencePenalty` when they are set.
  `GeminiFileAPI.uploadFile()` takes the file's contents (a `Uint8Array`, an `ArrayBuffer`, a
  `Blob` or a `ReadableStream`, with an optional `mimeType`) as well as a path, so uploads work on
  Cloudflare Workers. A path on a runtime without `node:fs` throws an error that says what to pass
  instead. `GeminiLiveLLMService` logs a warning when it drops an `LLMSetToolsFrame`. Comments and
  docs now say that WebSocket auth headers are sent on Cloudflare Workers.
- Updated dependencies [[`70dce6f`](https://github.com/polvallverdu/pipedog/commit/70dce6fcf5ffefa49ef2c21f87bac6377f0d5a09), [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301)]:
  - @pipedog/core@0.5.0
  - @pipedog/asyncio@0.5.0
  - @pipedog/serializer-protobuf@0.5.0
  - @pipedog/serializer-rtvi-client@0.5.0

## 0.4.0

### Minor Changes

- [#18](https://github.com/polvallverdu/pipedog/pull/18) [`b88231a`](https://github.com/polvallverdu/pipedog/commit/b88231af79d984e191b54c30965fa062a60ec8c3) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Lighter sessions, working default turn detection, and WebSockets with headers on Workers.
  
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

- [#15](https://github.com/polvallverdu/pipedog/pull/15) [`4e08d11`](https://github.com/polvallverdu/pipedog/commit/4e08d11ae099e09b09c97255bd9c21d040e311e6) Thanks [@polvallverdu](https://github.com/polvallverdu)! - WebSocket endpoints as fetch handlers. `websocketFetchHandler(onConnection)` returns a
  `(Request) => Promise<Response>` for runtimes that upgrade from fetch: Cloudflare Workers and
  Durable Objects (`WebSocketPair`), and Deno (`Deno.upgradeWebSocket`). Each connection goes to
  `onConnection` as a `WebsocketConnection`. A request that isn't an upgrade gets `426`.
  `upgradeWebSocket(request)` is the lower-level helper.

### Patch Changes

- Updated dependencies [[`b88231a`](https://github.com/polvallverdu/pipedog/commit/b88231af79d984e191b54c30965fa062a60ec8c3)]:
  - @pipedog/core@0.4.0
  - @pipedog/serializer-protobuf@0.4.0
  - @pipedog/serializer-rtvi-client@0.4.0
  - @pipedog/asyncio@0.4.0

## 0.3.0

### Minor Changes

- [#8](https://github.com/polvallverdu/pipedog/pull/8) [`6aa3dac`](https://github.com/polvallverdu/pipedog/commit/6aa3dacb45a967e7bc147ab2905b9d8a808fa8c0) Thanks [@polvallverdu](https://github.com/polvallverdu)! - First providers and transports.
  
  - `@pipedog/google`: `GoogleSTTService` (Cloud Speech v2, Chirp 3), `GoogleTTSService` (Chirp 3 HD
    streaming), `GoogleHttpTTSService`, `GeminiTTSService` and `GeminiSTTService` (Gemini Live,
    `gemini-3.5-transcribe-live`). The Gemini classes run everywhere, Workers included; the Cloud
    classes need the optional `@google-cloud/speech` / `@google-cloud/text-to-speech` peers (Bun,
    Node, Deno).
  - `@pipedog/langchain`: `LangchainProcessor` for any LangChain `Runnable`, LangGraph graphs included.
  - `@pipedog/transport-websocket`: `WebsocketServerTransport`, `WebsocketClientTransport`,
    `FastAPIWebsocketTransport` (bring your own socket: Bun, Deno, Node `ws`, Hono, Cloudflare
    `WebSocketPair`) and `RTVIClientTransport`.
  - `@pipedog/transport-smallwebrtc`: `SmallWebRTCTransport` and its request handler, compatible with
    Pipecat's `@pipecat-ai/small-webrtc-transport` client (Bun, Node, Deno).
  - Serializers, byte-identical to upstream: `ProtobufFrameSerializer`, `RTVIClientSerializer`,
    `TelnyxFrameSerializer`.
  - `@pipedog/core`: `utils/py_json` (Python's `json.dumps`/`json.loads`) and `utils/base64`. The
    protobuf codec rejects invalid UTF-8 in string fields, and `FrameSerializer.shouldIgnoreFrame`
    raises for a transport message that is not a dict, as upstream does.

### Patch Changes

- Updated dependencies [[`6aa3dac`](https://github.com/polvallverdu/pipedog/commit/6aa3dacb45a967e7bc147ab2905b9d8a808fa8c0)]:
  - @pipedog/core@0.3.0
  - @pipedog/serializer-protobuf@0.3.0
  - @pipedog/serializer-rtvi-client@0.3.0
  - @pipedog/asyncio@0.3.0
