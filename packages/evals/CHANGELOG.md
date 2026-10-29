# @pipedog/evals

## 0.11.0

### Minor Changes

- [#104](https://github.com/polvallverdu/pipedog/pull/104) [`34d7530`](https://github.com/polvallverdu/pipedog/commit/34d7530ae607e20db11114b1a5d981bbeb71fa88) Thanks [@polvallverdu](https://github.com/polvallverdu)! - LLM and other providers brought up to pipecat main after 1.14:
  
  - ⚠️ Perplexity: `PerplexityLLMService` (Sonar chat completions) is removed, as upstream deprecates
    it; use the new `PerplexityAgentHttpLLMService` for Perplexity's Agent API, with `preset`,
    `webSearch` and `maxSteps` settings ([#5985](https://github.com/polvallverdu/pipedog/issues/5985)).
  - New `SmallestLLMService` (Smallest's Electron models, OpenAI-compatible, [#6339](https://github.com/polvallverdu/pipedog/issues/6339)).
  - OpenAI: Responses services report an empty completion and default `gpt-6.1-terra` to no
    reasoning ([#6348](https://github.com/polvallverdu/pipedog/issues/6348), [#6434](https://github.com/polvallverdu/pipedog/issues/6434)); the realtime client tolerates unknown server events ([#6329](https://github.com/polvallverdu/pipedog/issues/6329)); image
    generation takes `moderation` ([#6432](https://github.com/polvallverdu/pipedog/issues/6432)).
  - AWS Bedrock: reasoning is pushed as thought frames and round-trips with its signature, and Nova's
    `<thinking>` text no longer reaches TTS ([#6229](https://github.com/polvallverdu/pipedog/issues/6229)).
  - Azure realtime authenticates through the `_authHeaders()` hook ([#6329](https://github.com/polvallverdu/pipedog/issues/6329)).
  - Together: `reasoningEffort` ([#6437](https://github.com/polvallverdu/pipedog/issues/6437)). Inception defaults to `mercury-3` ([#6397](https://github.com/polvallverdu/pipedog/issues/6397)).
  - Twilio: `apiKeySid` / `apiKeySecret` as an alternative to `authToken` for auto hang-up; the
    runner reads `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_REGION` and `TWILIO_EDGE` ([#6270](https://github.com/polvallverdu/pipedog/issues/6270),
    [#6293](https://github.com/polvallverdu/pipedog/issues/6293)).
  - Evals: `text_matches` expectations (failure kind `text_unmatched`, [#5991](https://github.com/polvallverdu/pipedog/issues/5991)) and the `expression`
    event ([#6303](https://github.com/polvallverdu/pipedog/issues/6303)); image requests with no registered image get an error answer ([#6350](https://github.com/polvallverdu/pipedog/issues/6350)).
  - CLI: the Perplexity entry uses `PerplexityAgentHttpLLMService`.

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0
  - @pipedog/audio-silero@0.11.0
  - @pipedog/kokoro@0.11.0
  - @pipedog/moonshine@0.11.0
  - @pipedog/ollama@0.11.0
  - @pipedog/serializer-rtvi-client@0.11.0
  - @pipedog/transport-websocket@0.11.0
  - @pipedog/whisper@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/audio-silero@0.10.0
  - @pipedog/kokoro@0.10.0
  - @pipedog/moonshine@0.10.0
  - @pipedog/ollama@0.10.0
  - @pipedog/serializer-rtvi-client@0.10.0
  - @pipedog/transport-websocket@0.10.0
  - @pipedog/whisper@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/audio-silero@0.9.0
  - @pipedog/kokoro@0.9.0
  - @pipedog/moonshine@0.9.0
  - @pipedog/ollama@0.9.0
  - @pipedog/serializer-rtvi-client@0.9.0
  - @pipedog/transport-websocket@0.9.0
  - @pipedog/whisper@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/audio-silero@0.8.0
  - @pipedog/core@0.8.0
  - @pipedog/moonshine@0.8.0
  - @pipedog/kokoro@0.8.0
  - @pipedog/ollama@0.8.0
  - @pipedog/serializer-rtvi-client@0.8.0
  - @pipedog/transport-websocket@0.8.0
  - @pipedog/whisper@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#51](https://github.com/polvallverdu/pipedog/pull/51) [`fb25ede`](https://github.com/polvallverdu/pipedog/commit/fb25edef3cb316a0581579de92ee4b3a17495d46) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add `@pipedog/evals`, the port of `pipecat.evals`, to test a bot end to end:
  
  - Scripted and simulated scenarios in YAML, with users simulated by an LLM persona.
  - TTS for the user's audio, with a disk cache.
  - A client transport that connects to the bot as an RTVI client.
  - Expectation matchers and an LLM judge (any `BaseClassifier`, or a factory).
  - Results, multi-bot suites from a manifest, and subprocess sessions.
  - The `pipedog-eval` CLI, with `run`, `judge` and `suite`.
  
  `@pipedog/runner` now detects an eval harness's `eval-connect` message on `/ws` and builds the
  eval transport. `@pipedog/evals` is an optional peer dependency of the runner.

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

- Updated dependencies [[`41278ae`](https://github.com/polvallverdu/pipedog/commit/41278ae4842de3534561ca725d18621c3fb27e8a), [`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/kokoro@0.7.0
  - @pipedog/moonshine@0.7.0
  - @pipedog/whisper@0.7.0
  - @pipedog/core@0.7.0
  - @pipedog/audio-silero@0.7.0
  - @pipedog/ollama@0.7.0
  - @pipedog/serializer-rtvi-client@0.7.0
  - @pipedog/transport-websocket@0.7.0
  - @pipedog/asyncio@0.7.0
