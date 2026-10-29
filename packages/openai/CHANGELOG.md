# @pipedog/openai

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
  - @pipedog/whisper@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/whisper@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/whisper@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/whisper@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [[`41278ae`](https://github.com/polvallverdu/pipedog/commit/41278ae4842de3534561ca725d18621c3fb27e8a), [`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/whisper@0.7.0
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1
  - @pipedog/whisper@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0
  - @pipedog/whisper@0.6.0

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
- Updated dependencies [[`70dce6f`](https://github.com/polvallverdu/pipedog/commit/70dce6fcf5ffefa49ef2c21f87bac6377f0d5a09), [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301)]:
  - @pipedog/core@0.5.0
  - @pipedog/asyncio@0.5.0
  - @pipedog/whisper@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`b88231a`](https://github.com/polvallverdu/pipedog/commit/b88231af79d984e191b54c30965fa062a60ec8c3)]:
  - @pipedog/core@0.4.0
  - @pipedog/whisper@0.4.0
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

- Updated dependencies [[`0977e55`](https://github.com/polvallverdu/pipedog/commit/0977e55a05c6fb4207a3b3f33f88af2edef3f0a5), [`6aa3dac`](https://github.com/polvallverdu/pipedog/commit/6aa3dacb45a967e7bc147ab2905b9d8a808fa8c0)]:
  - @pipedog/whisper@0.3.0
  - @pipedog/core@0.3.0
  - @pipedog/asyncio@0.3.0
