# @pipedog/onnx

## 0.7.0

### Minor Changes

- [#62](https://github.com/polvallverdu/pipedog/pull/62) [`41278ae`](https://github.com/polvallverdu/pipedog/commit/41278ae4842de3534561ca725d18621c3fb27e8a) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Port Pipecat's local speech models, all running in-process on `@pipedog/onnx` (no Python, no API key):
  
  - `@pipedog/kokoro`: `KokoroTTSService`, with the same Kokoro-82M model and voices files as upstream's
    kokoro-onnx (audio identical for the same input).
  - `@pipedog/piper`: `PiperTTSService` (Piper ONNX voices from rhasspy/piper-voices) and
    `PiperHttpTTSService` (a Piper HTTP server over `fetch`, also on Cloudflare Workers).
  - `@pipedog/pocket-tts`: `PocketTTSService`, Kyutai's Pocket TTS on ONNX graphs checked against
    pocket-tts 2.1.0.
  - `@pipedog/moonshine`: `MoonshineSTTService`, with Moonshine's own `.ort` models (all six
    architectures, streaming ones included).
  - `@pipedog/funasr`: `FunASRSTTService`, SenseVoiceSmall with FunASR's front end and post-processing.
  - `@pipedog/whisper`: the local `WhisperSTTService` (an ONNX port of faster-whisper: beam search,
    temperature fallback, `no_speech_prob`, hotwords and initial prompt), `WhisperSTTServiceMLX` (same
    engine; there is no MLX in JS) and the `utils` probability helpers.
  - `@pipedog/espeak-ng`: eSpeak NG phonemization (WASM) shared by Kokoro and Piper.
  - `@pipedog/onnx`: int32 and bool tensors, and `modelCacheDir()` / `downloadModelFile()` for
    downloaded models.
  - `@pipedog/evals`: the keyless local audio defaults work by name again (`kokoro` for the user's
    voice, `moonshine` and `whisper` for the transcriber).
  
  Models download on first use into `~/.cache/pipedog/<name>` (or `$PIPEDOG_CACHE_DIR`).

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies []:
  - @pipedog/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [[`70dce6f`](https://github.com/polvallverdu/pipedog/commit/70dce6fcf5ffefa49ef2c21f87bac6377f0d5a09), [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301)]:
  - @pipedog/core@0.5.0

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
  - @pipedog/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`6aa3dac`](https://github.com/polvallverdu/pipedog/commit/6aa3dacb45a967e7bc147ab2905b9d8a808fa8c0)]:
  - @pipedog/core@0.3.0

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
