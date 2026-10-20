---
"@pipedog/onnx": minor
"@pipedog/audio-silero": minor
"@pipedog/audio-smart-turn": minor
"@pipedog/core": minor
---

Local ONNX models. `@pipedog/onnx` is a small inference backend over `onnxruntime-node` (native,
fastest) or `onnxruntime-web` (WASM), both optional peer dependencies; `createOnnxBackend()` picks
the native one when it is installed. On Cloudflare Workers the `workerd` export condition runs
onnxruntime-web from its `.wasm` imported as a module. `@pipedog/audio-silero` ports
`SileroVADAnalyzer` with the upstream `silero_vad.onnx` included, and
`@pipedog/audio-smart-turn` provides `createLocalSmartTurnAnalyzerV3()`, core's analyzer wired to
an ONNX backend and the upstream `smart-turn-v3.2-cpu.onnx`. On Workers both models are passed in
as bytes. In core, `VADAnalyzer.voiceConfidence()` may now return a promise.
