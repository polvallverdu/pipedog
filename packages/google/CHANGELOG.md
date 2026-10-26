# @pipedog/google

## 0.10.0

### Minor Changes

- [#85](https://github.com/polvallverdu/pipedog/pull/85) [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Google speech services: `GoogleSTTService` gets `finalizeOnVadStop` (half-close the request stream on `VADUserStoppedSpeakingFrame`, so the final transcript arrives in about 0.6 s instead of Google's ~1.5 s endpointing, merged into one finalized `TranscriptionFrame`) and accepts `GoogleSTTSettings.languageCodes` again (e.g. `["auto"]` for Chirp's language detection; transcripts carry the detected language). `GoogleTTSService` and `GeminiTTSService` accept an injected `client` (share one Cloud TTS client across calls) and `bufferOnlyStartup` (buffer only the start of each utterance), and `GeminiTTSSettings` gets `speakingRate`. A gRPC CANCELLED error (an interrupted or cancelled call) now ends a Google Cloud stream quietly instead of being reported as an error.

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Minor Changes

- [#69](https://github.com/polvallverdu/pipedog/pull/69) [`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Options for bundled apps, where an import by name at run time can't be followed:
  
  - `@pipedog/onnx`: `createOnnxBackend({ prefer: "web", web: { ort, wasmPaths } })`. Pass `onnxruntime-web` imported by you, and its loader and `.wasm` as `with { type: "file" }` imports, and Silero and Smart Turn run on WebAssembly entirely inside the bundle, also with `bun build --compile`. `createOnnxBackend` also takes `native: { ort }`, and `createWebBackend` takes `wasmPaths`. Measured on Bun (Apple M4 Pro): Silero 0.20 ms per chunk against 0.14 ms with `onnxruntime-node`, Smart Turn inference 166 ms against 72 ms. `onnxruntime-node` is a native addon and stays outside a bundle. New export: `withDefaultModelHint`. `@pipedog/onnx` now depends on `@pipedog/asyncio`.
  - `@pipedog/google`: `GoogleSTTService` takes `speechModule`, and the Cloud TTS services take `textToSpeechModule`: the `@google-cloud/speech` / `@google-cloud/text-to-speech` module imported by your bot, instead of the services importing it by name. The gRPC SDKs then bundle (about 4 MB). `@google/genai` stays a dependency.

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Patch Changes

- [#47](https://github.com/polvallverdu/pipedog/pull/47) [`61b0e2d`](https://github.com/polvallverdu/pipedog/commit/61b0e2db3ad3d095c31ed12846fa7ec33f821909) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add `@pipedog/flows`, a port of Pipecat Flows: nodes, direct functions, actions, context strategies, YAML/JSON flow configs (`FlowConfig`, `Flow`) and `FlowManager`, with docs and end-to-end tests on OpenAI, Anthropic and Google. `@pipedog/google` now sends tools to Gemini in the form the JS SDK reads (`functionDeclarations`); before, function calling offered the model no tools.
- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0

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

## 0.4.0

### Patch Changes

- Updated dependencies [[`b88231a`](https://github.com/polvallverdu/pipedog/commit/b88231af79d984e191b54c30965fa062a60ec8c3)]:
  - @pipedog/core@0.4.0
  - @pipedog/asyncio@0.4.0

## 0.3.0

### Minor Changes

- [#10](https://github.com/polvallverdu/pipedog/pull/10) [`0977e55`](https://github.com/polvallverdu/pipedog/commit/0977e55a05c6fb4207a3b3f33f88af2edef3f0a5) Thanks [@polvallverdu](https://github.com/polvallverdu)! - LLM services: OpenAI, Anthropic, and the rest of Google.
  
  - `@pipedog/openai`: `OpenAILLMService`, `OpenAIResponsesLLMService`, `OpenAIRealtimeLLMService`,
    `OpenAILiveLLMService`, `OpenAISTTService`, `OpenAITTSService`, `OpenAIImageGenService`, and the
    matching adapters.
  - `@pipedog/anthropic`: `AnthropicLLMService` and `AnthropicLLMAdapter`, with prompt caching and
    extended thinking, on `@anthropic-ai/sdk`.
  - `@pipedog/whisper`: `BaseWhisperSTTService`, the base class `OpenAISTTService` builds on.
  - `@pipedog/google`: `GoogleLLMService`, `GoogleVertexLLMService`, `GeminiLiveLLMService`,
    `GeminiLiveVertexLLMService`, `GeminiSTTService`, `GeminiTTSService`, `GoogleImageGenService`,
    `GeminiFileAPI`, and `GoogleRTVIProcessor` / `GoogleRTVIObserver`.

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
  - @pipedog/asyncio@0.3.0
