# @pipedog/together

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

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`34d7530`](https://github.com/polvallverdu/pipedog/commit/34d7530ae607e20db11114b1a5d981bbeb71fa88), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0
  - @pipedog/openai@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/openai@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/openai@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/openai@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/openai@0.7.0
  - @pipedog/asyncio@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1
  - @pipedog/openai@0.6.1

## 0.6.0

### Minor Changes

- [#37](https://github.com/polvallverdu/pipedog/pull/37) [`7eeca04`](https://github.com/polvallverdu/pipedog/commit/7eeca04f5aa124575a8806051c5f6efe7b241c11) Thanks [@polvallverdu](https://github.com/polvallverdu)! - OpenAI-compatible providers with speech services, one package each:
  
  - `@pipedog/groq`: `GroqLLMService` (with `reasoningEffort`), `GroqSTTService` (Whisper models) and
    `GroqTTSService`.
  - `@pipedog/mistral`: `MistralLLMService` and `MistralLLMAdapter`, `MistralSTTService` (Voxtral
    realtime) and `MistralTTSService` (Voxtral TTS).
  - `@pipedog/together`: `TogetherLLMService` (with a `reasoning` toggle), `TogetherSTTService` and
    `TogetherTTSService`, over WebSockets.
  - `@pipedog/xai`: `GrokLLMService` (with `reasoningEffort`), `XAISTTService`, and `XAITTSService`
    (WebSocket, word timestamps) and `XAIHttpTTSService`.
  - `@pipedog/grok`: the deprecated alias of `@pipedog/xai/llm`.

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0
  - @pipedog/openai@0.6.0
