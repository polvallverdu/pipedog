# @pipedog/anthropic

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Patch Changes

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

- [#20](https://github.com/polvallverdu/pipedog/pull/20) [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Package READMEs on npm. `@pipedog/core`, `@pipedog/asyncio`, `@pipedog/openai`,
  `@pipedog/anthropic`, `@pipedog/deepgram`, `@pipedog/cartesia`, `@pipedog/elevenlabs`,
  `@pipedog/tracing` and `@pipedog/whisper` now ship a README with install steps, a usage snippet,
  runtimes and links to the docs. Every package gains npm `keywords`, and the `@pipedog/elevenlabs`
  description no longer lists Text-to-Dialogue, which is not ported yet.
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

### Patch Changes

- Updated dependencies [[`6aa3dac`](https://github.com/polvallverdu/pipedog/commit/6aa3dacb45a967e7bc147ab2905b9d8a808fa8c0)]:
  - @pipedog/core@0.3.0
  - @pipedog/asyncio@0.3.0
