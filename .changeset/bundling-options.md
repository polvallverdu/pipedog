---
"@pipedog/onnx": minor
"@pipedog/google": minor
---

Options for bundled apps, where an import by name at run time can't be followed:

- `@pipedog/onnx`: `createOnnxBackend({ prefer: "web", web: { ort, wasmPaths } })`. Pass `onnxruntime-web` imported by you, and its loader and `.wasm` as `with { type: "file" }` imports, and Silero and Smart Turn run on WebAssembly entirely inside the bundle, also with `bun build --compile`. `createOnnxBackend` also takes `native: { ort }`, and `createWebBackend` takes `wasmPaths`. Measured on Bun (Apple M4 Pro): Silero 0.20 ms per chunk against 0.14 ms with `onnxruntime-node`, Smart Turn inference 166 ms against 72 ms. `onnxruntime-node` is a native addon and stays outside a bundle. New export: `withDefaultModelHint`. `@pipedog/onnx` now depends on `@pipedog/asyncio`.
- `@pipedog/google`: `GoogleSTTService` takes `speechModule`, and the Cloud TTS services take `textToSpeechModule`: the `@google-cloud/speech` / `@google-cloud/text-to-speech` module imported by your bot, instead of the services importing it by name. The gRPC SDKs then bundle (about 4 MB). `@google/genai` stays a dependency.
