# @pipedog/core

## 0.10.0

### Minor Changes

- [#85](https://github.com/polvallverdu/pipedog/pull/85) [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - TTS audio cache (pipedog only): `TTSService` takes an optional `audioCache` (`TTSAudioCache`, an in-memory LRU bounded by size, or any `get`/`set` store), and `warmAudioCache(text)` synthesizes fixed lines ahead of time so they play without a request to the provider. Only warmed lines are stored unless `cacheSynthesizedAudio` allows live synthesis. Works with services that yield audio from `runTts` (HTTP and streaming-RPC).

- [#85](https://github.com/polvallverdu/pipedog/pull/85) [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `MinWordsUserTurnStartStrategy` takes two opt-in options: `startOnVadWhenBotQuiet` starts the turn
  on VAD while the bot is silent instead of waiting for a transcript, and `keepBotSpeakingOnTurnStart`
  keeps the bot-speaking state across turn starts. New user mute strategies:
  `OpeningUserMuteStrategy` (mute until the bot's first speech ends or has played for `maxSeconds`)
  and `EndingUserMuteStrategy` (mute for good once the conversation is ending).

### Patch Changes

- Updated dependencies []:
  - @pipedog/asyncio@0.10.0
  - @pipedog/resampler-wasm@0.10.0
  - @pipedog/sentencex-wasm@0.10.0

## 0.9.0

### Minor Changes

- [#76](https://github.com/polvallverdu/pipedog/pull/76) [`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Frames move through a pipeline about twice as fast (per-frame latency through 10 processors: 83 → 40 µs on Node, 370 → 180 µs on Cloudflare Workers), with the same behavior:
  
  - The pipeline worker no longer wakes an observer for events it doesn't handle: `onProcessFrame` events only go to observers that override `onProcessFrame` (the default observers only watch pushes).
  - New `BaseObserver.acceptsPush(data)`: a synchronous filter the worker calls before queueing a push for an observer. `RTVIObserver` uses it to skip the repeated pushes it ignores, so it is no longer woken at every hop of every frame.
  - `FrameProcessor` skips the per-frame `on_before/after_process_frame` and `on_before/after_push_frame` events when nothing listens to them, and builds its trace log line only when trace logging is on.

- [#72](https://github.com/polvallverdu/pipedog/pull/72) [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add `defineTool` (`@pipedog/core/adapters/schemas/standard_tool`): typed function-calling tools from any Standard Schema (Zod, Valibot, ArkType). The JSON schema comes from Standard JSON Schema (`~standard.jsonSchema`) or an explicit `jsonSchema`, the handler's `args` are inferred, and arguments are validated before the handler runs; invalid arguments are returned to the LLM as the result. It returns a regular `FunctionSchema`, so existing APIs are unchanged. Also adds `registerTools` and the copied Standard Schema interfaces in `@pipedog/core/utils/standard_schema`.

### Patch Changes

- Updated dependencies []:
  - @pipedog/asyncio@0.9.0
  - @pipedog/resampler-wasm@0.9.0
  - @pipedog/sentencex-wasm@0.9.0

## 0.8.0

### Patch Changes

- [#69](https://github.com/polvallverdu/pipedog/pull/69) [`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Fixes for apps bundled with `bun build` (and `bun build --compile`) and run without `node_modules`:
  
  - `@pipedog/transport-smallwebrtc` loads `reflect-metadata` first itself (a new dependency, pinned). werift's X.509 code needs it before `tsyringe`, and a bundle that loads the transport lazily, as `@pipedog/runner` does, could put the import after it, which disabled the runner's WebRTC routes. Hosts don't import or externalize `reflect-metadata`; it does not belong in core.
  - `@pipedog/runner` counts its own transports (`@pipedog/transport-websocket`, `@pipedog/transport-smallwebrtc`) as available instead of resolving them by name, which fails in a bundle: every telephony and WebSocket route answered 404.
  - Silero, Smart Turn and RNNoise read their default model or `.wasm` file next to the package's source, which a bundle does not copy. The error now names the `model` option (or `initRnnoise()`) and the `with { type: "file" }` import that fixes it, instead of a bare file-not-found for a path nobody recognizes.
  - Core's Smart Turn fallback warning says that a bundled app has to pass `createLocalSmartTurnAnalyzerV3()` to the turn strategy, since a bundler can't see core's by-name import.
  
  Docs: a Bundling page under Deployment, with the tested `bun build` recipe, a snippet per asset, and what has to stay outside the bundle and why. `examples/bundle-check` bundles and runs a sample bot per configuration in CI.
- Updated dependencies []:
  - @pipedog/asyncio@0.8.0
  - @pipedog/resampler-wasm@0.8.0
  - @pipedog/sentencex-wasm@0.8.0

## 0.7.0

### Minor Changes

- [#68](https://github.com/polvallverdu/pipedog/pull/68) [`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Traces say pipedog now. The library's tracers are called `pipedog` and `pipedog.turn` (they were
  `pipecat` and `pipecat.turn`, as upstream), and `setupTracing()` defaults `service.name` to
  `"pipedog"` (was `"pipecat"`). Span names and attribute keys are unchanged.
  
  If a dashboard, alert or query filters on the Pipecat tracer names, bring them back at startup,
  before creating a pipeline, with `setTracerName("pipecat")` or `setupTracing({ tracerName:
  "pipecat" })`. `getTracerName()` and `DEFAULT_TRACER_NAME` are exported too. Set your own
  `serviceName` in production either way.

### Patch Changes

- Updated dependencies []:
  - @pipedog/asyncio@0.7.0
  - @pipedog/resampler-wasm@0.7.0
  - @pipedog/sentencex-wasm@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/resampler-wasm@0.6.1
  - @pipedog/sentencex-wasm@0.6.1

## 0.6.0

### Minor Changes

- [#32](https://github.com/polvallverdu/pipedog/pull/32) [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Speech-to-speech providers: Inworld and Ultravox.
  
  - `@pipedog/inworld`: `InworldRealtimeLLMService` (Inworld's Realtime API, with its events and
    adapter), and `InworldTTSService` (WebSocket) and `InworldHttpTTSService`.
  - `@pipedog/ultravox`: `UltravoxRealtimeLLMService`, with agent, one-shot and join-URL calls.
  - `@pipedog/core`: `ServiceSettings.fromMapping()` builds the subclass it is called on again, so
    `TTSSettings.fromMapping({ voice_id: "alice" })` sets `voice` instead of putting every key in
    `extra`.
  
  Both run on Bun, Node, Deno and Cloudflare Workers.

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/resampler-wasm@0.6.0
  - @pipedog/sentencex-wasm@0.6.0

## 0.5.0

### Patch Changes

- [#28](https://github.com/polvallverdu/pipedog/pull/28) [`70dce6f`](https://github.com/polvallverdu/pipedog/commit/70dce6fcf5ffefa49ef2c21f87bac6377f0d5a09) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `GoogleLLMService` sends `frequencyPenalty` and `presencePenalty` when they are set.
  `GeminiFileAPI.uploadFile()` takes the file's contents (a `Uint8Array`, an `ArrayBuffer`, a
  `Blob` or a `ReadableStream`, with an optional `mimeType`) as well as a path, so uploads work on
  Cloudflare Workers. A path on a runtime without `node:fs` throws an error that says what to pass
  instead. `GeminiLiveLLMService` logs a warning when it drops an `LLMSetToolsFrame`. Comments and
  docs now say that WebSocket auth headers are sent on Cloudflare Workers.

- [#20](https://github.com/polvallverdu/pipedog/pull/20) [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Package READMEs on npm. `@pipedog/core`, `@pipedog/asyncio`, `@pipedog/openai`,
  `@pipedog/anthropic`, `@pipedog/deepgram`, `@pipedog/cartesia`, `@pipedog/elevenlabs`,
  `@pipedog/tracing` and `@pipedog/whisper` now ship a README with install steps, a usage snippet,
  runtimes and links to the docs. Every package gains npm `keywords`, and the `@pipedog/elevenlabs`
  description no longer lists Text-to-Dialogue, which is not ported yet.
- Updated dependencies [[`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301)]:
  - @pipedog/asyncio@0.5.0
  - @pipedog/resampler-wasm@0.5.0
  - @pipedog/sentencex-wasm@0.5.0

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

### Patch Changes

- Updated dependencies []:
  - @pipedog/asyncio@0.4.0
  - @pipedog/resampler-wasm@0.4.0
  - @pipedog/sentencex-wasm@0.4.0

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

- Updated dependencies []:
  - @pipedog/asyncio@0.3.0
  - @pipedog/resampler-wasm@0.3.0
  - @pipedog/sentencex-wasm@0.3.0

## 0.2.0

### Minor Changes

- [#4](https://github.com/polvallverdu/pipedog/pull/4) [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `SOXRAudioResampler` and `SOXRStreamAudioResampler` now resample instead of throwing "not ported yet" when the rates differ. This also fixes `createFileResampler()`, `createStreamResampler()`, the μ-law/A-law helpers at other rates, `loadDtmfAudio()` at rates other than 8 kHz, `LocalSmartTurnAnalyzerV3` at rates other than 16 kHz, and output transports and TTS services whose rates differ. The resampling goes through a small engine interface in `@pipedog/core/audio/resamplers/engine`:
  
  - The default engine is `@pipedog/resampler-wasm`, which core now depends on. It loads lazily on first use, and on Cloudflare Workers it loads through the package's `workerd` export condition.
  - If WebAssembly cannot be loaded, core logs one warning and falls back to a pure-TypeScript windowed-sinc engine with soxr-like presets (`createSincResamplerEngine()`).
  - `setResamplerEngine(engine)` lets apps inject their own engine, for example a native soxr binding. `getResamplerEngine()` resolves to the engine in use.
  
  The quality presets (VHQ by default, then HQ, MQ, LQ and QQ), clearing after inactivity, `flush()` and `reset()` behave as before. Equal rates still return the input unchanged.
  
  `@pipedog/resampler-wasm`: `initResampler()` falls back to an embedded copy of the module (`src/wasm_bytes.ts`) when the `.wasm` file next to the package cannot be read, for example after bundling.
  
  `@pipedog/resampler-wasm`: the quality presets now follow libsoxr's quality table. The stopband starts at the Nyquist frequency of the lower rate. MQ, HQ and VHQ are flat to about 0.91 of it and differ mainly in attenuation: about 111, 138 and at least 157 dB. LQ (about 112 dB) and QQ (about 75 dB) have earlier roll-offs. The filter is stretched when downsampling, so it no longer leaks aliases at large ratios: a 5 kHz tone resampled from 48 kHz to 8 kHz is now 87 to 163 dB down, depending on the preset. Processing is now done in f64. Output samples, filter delays (about 8.5 ms at VHQ) and `qualityInfo()` values change; the output lengths do not.

- [#4](https://github.com/polvallverdu/pipedog/pull/4) [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Fill four gaps in core that upstream tests exercise:
  
  - Resampling works: `SOXRAudioResampler`, `SOXRStreamAudioResampler` and `soxrResample` run on
    `@pipedog/resampler-wasm` (now a dependency) instead of throwing, so TTS services, output
    transports and the audio buffer processor can convert sample rates. Call `await initSoxr()`
    before the synchronous `soxrResample`; the async resamplers do it themselves.
  - `encodeImage()` JPEG-encodes raw `L`/`LA`/`RGB`/`RGBA`/`RGBX` pixels with a built-in baseline
    encoder (`utils/jpeg_encoder`), so raw image frames reach LLMs and classifiers.
  - `utils/yaml`: `includeLoader()` / `addIncludeConstructor()` work, with a PyYAML-style
    `SafeLoader` (YAML 1.1 resolvers, per-class constructors) and `load()` on top of the `yaml`
    package. Included files are read with an injected `readFile`.
  - `LocalFileStorage` saves, loads, deletes and trims files through an injected `fs`
    (`node:fs/promises` fits as is).

- [#4](https://github.com/polvallverdu/pipedog/pull/4) [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Core is fully ported (all 361 upstream modules): the text transforms that make text speakable for
  TTS (numbers, currency, dates, percentages, phone numbers, units, acronyms, email, markdown,
  replacements, pronunciations, `VoiceFormatter`) and the WebSocket proxy client. Numbers are spoken
  with `num2words-ts`, as upstream uses `num2words`; Unicode digits (e.g. "٥٠") are recognised and
  read like upstream does.

- [#6](https://github.com/polvallverdu/pipedog/pull/6) [`72b8cb8`](https://github.com/polvallverdu/pipedog/commit/72b8cb82b807d7b194f525872bc0ac662a9df3dc) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Local ONNX models. `@pipedog/onnx` is a small inference backend over `onnxruntime-node` (native,
  fastest) or `onnxruntime-web` (WASM), both optional peer dependencies; `createOnnxBackend()` picks
  the native one when it is installed. On Cloudflare Workers the `workerd` export condition runs
  onnxruntime-web from its `.wasm` imported as a module. `@pipedog/audio-silero` ports
  `SileroVADAnalyzer` with the upstream `silero_vad.onnx` included, and
  `@pipedog/audio-smart-turn` provides `createLocalSmartTurnAnalyzerV3()`, core's analyzer wired to
  an ONNX backend and the upstream `smart-turn-v3.2-cpu.onnx`. On Workers both models are passed in
  as bytes. In core, `VADAnalyzer.voiceConfidence()` may now return a promise.

- [#6](https://github.com/polvallverdu/pipedog/pull/6) [`72b8cb8`](https://github.com/polvallverdu/pipedog/commit/72b8cb82b807d7b194f525872bc0ac662a9df3dc) Thanks [@polvallverdu](https://github.com/polvallverdu)! - OpenTelemetry tracing, as in Pipecat's `pipecat-ai[tracing]` extra, on Bun, Node, Deno and Cloudflare Workers.
  
  `@pipedog/core`: `@opentelemetry/api` is now an optional peer dependency. When it is installed, core imports it on its own (a dynamic `import()` started when `utils/tracing/setup` loads, with no top-level await), and `isTracingAvailable()` turns true, like upstream's `is_tracing_available()`. Without it, core runs as before and tracing stays a no-op. `PipelineWorker` awaits that import in its async setup before deciding whether to trace, so construction order does not matter (a worker built at module top level traces too); `loadOpenTelemetry()` exposes the same wait. `registerOpenTelemetry()` still registers the modules explicitly and now wins over the automatic import. The structural OpenTelemetry types accept the real `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` modules (array attribute values may hold `null`/`undefined`, as in OpenTelemetry). Span names, attributes and hierarchy are unchanged and match upstream's.
  
  `@pipedog/tracing` (new): `setupTracing({ serviceName, exporter, consoleExport })`, matching upstream's `setup_tracing()`: it registers `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` and `@opentelemetry/resources` with core and installs a global tracer provider with batch span processors for the given exporter and, optionally, the console. It re-exports `OTLPTraceExporter` (OTLP/HTTP JSON, from `@opentelemetry/exporter-trace-otlp-http`), `ConsoleSpanExporter`, `InMemorySpanExporter` and the span processors. `forceFlushTracing()` and `shutdownTracing()` export what the batch processors still hold, e.g. `ctx.waitUntil(forceFlushTracing())` on Cloudflare Workers. `@opentelemetry/api` is a peer dependency.

### Patch Changes

- [#7](https://github.com/polvallverdu/pipedog/pull/7) [`122b72f`](https://github.com/polvallverdu/pipedog/commit/122b72fb4167cf2b12112d83de5ed255c9e0d897) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `@pipedog/asyncio` now schedules like asyncio, so ported code interleaves exactly as it does in
  Python. Waking a waiter (a future's result, `Event.set()`, `Queue.put()`, a task finishing, a
  timer) no longer resumes it on the next microtask: the wakeup goes on a FIFO ready queue
  (`callSoon`), and queued wakeups run one at a time, each once the microtask queue is empty. A task
  therefore runs until it awaits something that is not done; `get()` on a non-empty queue, `put()` on
  an unbounded one, `wait()` on a set event and awaiting a done task do not let any other task run,
  and `sleep(0)` yields exactly one turn. The turn is driven by a MessageChannel on Node,
  `setImmediate` on Bun and Deno, and a body read on Cloudflare Workers.
  
  - New: `Future` (asyncio.Future: `setResult`, `setException`, `cancel`, done callbacks; awaitable),
    `callSoon` / `callLater` returning a cancellable `Handle`, `isFuture`. `Task` extends `Future`.
  - `Event`, `Queue` (and `PriorityQueue`, `LifoQueue`), `Lock`, `Semaphore`, `gather`, `wait`,
    `shield`, `waitFor` and `timeout` are ported from CPython on top of `Future`, with its wakeup
    rules: a woken `get()` takes whatever is at the head when it runs (so a `PriorityQueue` hands
    out the smallest item of a burst), a cancellation that arrives after the wakeup was queued wins,
    `gather` raises a cancellation once its children are done, and `addDoneCallback` callbacks run
    on the ready queue.
  - `waitFor(fn, t)` and `timeout(t, fn)` run `fn` in the current task, like Python 3.12+: on
    expiry the task is cancelled and the `CancelledError` becomes `TimeoutError`. When every
    cancellation request has been withdrawn with `uncancel()`, `task.signal` is a fresh signal.
  - `Queue` uses O(1) removal from the front (it used `Array.shift()`, which is O(n) on V8 and made
    long queues quadratic on Node, Deno and Workers).
  - 32 interleaving scenarios recorded from CPython 3.14 (`test/python/scenarios.py`) are replayed in
    the tests and in the compat smoke test on all four runtimes.
  
  `@pipedog/core`: `LLMAssistantAggregator` runs the LLM once for a burst of
  `LLMMessagesAppendFrame` / `FunctionCallResultFrame` instead of once per frame. Its
  `hasQueuedFrame(...)` check now sees the later frames of the burst queued, as upstream does, so
  there are no more duplicate responses. Other frame orderings that depend on asyncio scheduling
  (system frames overtaking queued data frames, bus priority, interruption handling) now match
  upstream too.
- Updated dependencies [[`122b72f`](https://github.com/polvallverdu/pipedog/commit/122b72fb4167cf2b12112d83de5ed255c9e0d897), [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3)]:
  - @pipedog/asyncio@0.2.0
  - @pipedog/resampler-wasm@0.2.0
  - @pipedog/sentencex-wasm@0.2.0

## 0.1.0

### Minor Changes

- [`4c0f6d3`](https://github.com/polvallverdu/pipedog/commit/4c0f6d30ff6342307eeca541e0ecebfbd9c540f1) Thanks [@polvallverdu](https://github.com/polvallverdu)! - First release: the Pipecat core runtime (frames, processors, pipelines, workers, bus, observers,
  RTVI, base services and transports), asyncio-style cancellation for JavaScript, and the
  sentencex and resampler WebAssembly packages. Runs on Bun, Node, Deno and Cloudflare Workers.

### Patch Changes

- Updated dependencies []:
  - @pipedog/asyncio@0.1.0
  - @pipedog/sentencex-wasm@0.1.0
