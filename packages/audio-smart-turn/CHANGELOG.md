# @pipedog/audio-smart-turn

## 0.11.0

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0
  - @pipedog/onnx@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/onnx@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/onnx@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- [#69](https://github.com/polvallverdu/pipedog/pull/69) [`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Fixes for apps bundled with `bun build` (and `bun build --compile`) and run without `node_modules`:
  
  - `@pipedog/transport-smallwebrtc` loads `reflect-metadata` first itself (a new dependency, pinned). werift's X.509 code needs it before `tsyringe`, and a bundle that loads the transport lazily, as `@pipedog/runner` does, could put the import after it, which disabled the runner's WebRTC routes. Hosts don't import or externalize `reflect-metadata`; it does not belong in core.
  - `@pipedog/runner` counts its own transports (`@pipedog/transport-websocket`, `@pipedog/transport-smallwebrtc`) as available instead of resolving them by name, which fails in a bundle: every telephony and WebSocket route answered 404.
  - Silero, Smart Turn and RNNoise read their default model or `.wasm` file next to the package's source, which a bundle does not copy. The error now names the `model` option (or `initRnnoise()`) and the `with { type: "file" }` import that fixes it, instead of a bare file-not-found for a path nobody recognizes.
  - Core's Smart Turn fallback warning says that a bundled app has to pass `createLocalSmartTurnAnalyzerV3()` to the turn strategy, since a bundler can't see core's by-name import.
  
  Docs: a Bundling page under Deployment, with the tested `bun build` recipe, a snippet per asset, and what has to stay outside the bundle and why. `examples/bundle-check` bundles and runs a sample bot per configuration in CI.
- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8), [`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/onnx@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#52](https://github.com/polvallverdu/pipedog/pull/52) [`84f2ad1`](https://github.com/polvallverdu/pipedog/commit/84f2ad14d46caf4214cd9a5ddd9d8d3038c39e9e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Five more upstream modules.
  
  - `@pipedog/audio-smart-turn`: `HttpSmartTurnAnalyzer`, Smart Turn over HTTP. It needs only `fetch`, so it runs on every runtime, Workers included, and takes a `fetch` option where upstream takes an aiohttp session.
  - `@pipedog/audio-rnnoise-filter` (new): `RNNoiseFilter`. RNNoise 0.2 runs as WebAssembly (the module `@jitsi/rnnoise-wasm` builds, 1.4 MB, shipped in the package) instead of the native `pyrnnoise`, so it works on Bun, Node, Deno and Cloudflare Workers.
  - `@pipedog/audio-soundfile-mixer` (new): `SoundfileMixer`. WAV only, parsed in pure TypeScript instead of libsndfile. Sounds can be bytes, a URL or a path (a path needs a filesystem).
  - `@pipedog/transport-whatsapp` (new): `WhatsAppClient` and `WhatsAppApi` for WhatsApp Business calling: Meta's webhooks, HMAC signature checks, `pre_accept`, `accept`, `reject` and `terminate`, on SmallWebRTC. Whole calls run on Bun, Node and Deno. On Workers only the webhook verification, signature check and API calls work.
  - `@pipedog/transport-local` (new): `LocalAudioTransport`, the machine's microphone and speakers through `sox` or `ffmpeg` child processes, with no native addon. Bun, Node and Deno only. It throws a clear error when neither tool is installed.
  
  Docs: a new Audio filters & mixers section, the HTTP Smart Turn section of the turn detection page, WhatsApp and Local audio transport pages, and a per-package runtime matrix that also says what each runtime needs. Not ported, on purpose: `local_smart_turn_v2`, `local_coreml_smart_turn` (Smart Turn v3 replaces them) and the Tkinter transport.

### Patch Changes

- Updated dependencies [[`41278ae`](https://github.com/polvallverdu/pipedog/commit/41278ae4842de3534561ca725d18621c3fb27e8a), [`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/onnx@0.7.0
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies []:
  - @pipedog/core@0.6.1
  - @pipedog/onnx@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/core@0.6.0
  - @pipedog/onnx@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [[`70dce6f`](https://github.com/polvallverdu/pipedog/commit/70dce6fcf5ffefa49ef2c21f87bac6377f0d5a09), [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301)]:
  - @pipedog/core@0.5.0
  - @pipedog/onnx@0.5.0

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

- Updated dependencies [[`b88231a`](https://github.com/polvallverdu/pipedog/commit/b88231af79d984e191b54c30965fa062a60ec8c3)]:
  - @pipedog/onnx@0.4.0
  - @pipedog/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`6aa3dac`](https://github.com/polvallverdu/pipedog/commit/6aa3dacb45a967e7bc147ab2905b9d8a808fa8c0)]:
  - @pipedog/core@0.3.0
  - @pipedog/onnx@0.3.0

## 0.2.0

### Minor Changes

- [#6](https://github.com/polvallverdu/pipedog/pull/6) [`72b8cb8`](https://github.com/polvallverdu/pipedog/commit/72b8cb82b807d7b194f525872bc0ac662a9df3dc) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Local ONNX models. `@pipedog/onnx` is a small inference backend over `onnxruntime-node` (native,
  fastest) or `onnxruntime-web` (WASM), both optional peer dependencies; `createOnnxBackend()` picks
  the native one when it is installed. On Cloudflare Workers the `workerd` export condition runs
  onnxruntime-web from its `.wasm` imported as a module. `@pipedog/audio-silero` ports
  `SileroVADAnalyzer` with the upstream `silero_vad.onnx` included, and
  `@pipedog/audio-smart-turn` provides `createLocalSmartTurnAnalyzerV3()`, core's analyzer wired to
  an ONNX backend and the upstream `smart-turn-v3.2-cpu.onnx`. On Workers both models are passed in
  as bytes. In core, `VADAnalyzer.voiceConfidence()` may now return a promise.

### Patch Changes

- Updated dependencies [[`122b72f`](https://github.com/polvallverdu/pipedog/commit/122b72fb4167cf2b12112d83de5ed255c9e0d897), [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3), [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3), [`f59cf26`](https://github.com/polvallverdu/pipedog/commit/f59cf264cc2a81482df319ebb2363a9d5b4a6dd3), [`72b8cb8`](https://github.com/polvallverdu/pipedog/commit/72b8cb82b807d7b194f525872bc0ac662a9df3dc), [`72b8cb8`](https://github.com/polvallverdu/pipedog/commit/72b8cb82b807d7b194f525872bc0ac662a9df3dc)]:
  - @pipedog/core@0.2.0
  - @pipedog/onnx@0.2.0
