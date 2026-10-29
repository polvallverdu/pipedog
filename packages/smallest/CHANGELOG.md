# @pipedog/smallest

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

- [#103](https://github.com/polvallverdu/pipedog/pull/103) [`3fe7566`](https://github.com/polvallverdu/pipedog/commit/3fe756637d4a7364c095d40c877d89ba456fd44e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Speech providers brought up to pipecat main after 1.14:
  
  - Expression adapters for expressive conversation (alpha): `CartesiaExpressionAdapter`
    (`@pipedog/cartesia/cartesia_adapter`, `CartesiaEmotion` now lives there),
    `ElevenLabsAudioTagExpressionAdapter`, Fish Audio S2 and MiniMax adapters. With
    `enableExpressiveConversation`, the TTS services perform the tags the LLM writes.
  - Cartesia: `accent` setting ([#6429](https://github.com/polvallverdu/pipedog/issues/6429)), regional locales and CJK punctuation tokens; the turns STT
    reconnects from its receive loop and ends a turn cut short by a dropped connection with the
    transcript so far ([#6242](https://github.com/polvallverdu/pipedog/issues/6242)).
  - ElevenLabs: audio tags reported as words, and the word clock advances on wordless alignment
    ([#6297](https://github.com/polvallverdu/pipedog/issues/6297)).
  - Deepgram: the TTS and Flux services report the `dg-error` reason of a refused connection, and
    Flux STT waits for `Connected` through the core `_receiveUntilConfirmed`.
  - Inworld TTS reconnects from its receive loop ([#6300](https://github.com/polvallverdu/pipedog/issues/6300)); Sarvam STT reconnects ([#6342](https://github.com/polvallverdu/pipedog/issues/6342)).
  - Smallest: `dateFormat` and the `"redact"` content filter ([#6431](https://github.com/polvallverdu/pipedog/issues/6431)). Speechify: `pronunciations`
    ([#6436](https://github.com/polvallverdu/pipedog/issues/6436)) and `simba-3.5` as the default model. Google Vertex defaults to `gemini-3.8-flash`.

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`34d7530`](https://github.com/polvallverdu/pipedog/commit/34d7530ae607e20db11114b1a5d981bbeb71fa88), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0
  - @pipedog/openai@0.11.0

## 0.10.0

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

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#58](https://github.com/polvallverdu/pipedog/pull/58) [`cc21620`](https://github.com/polvallverdu/pipedog/commit/cc21620aa0d9d6a0f4dab793197cf24ced3eecc1) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add `@pipedog/sarvam` (SarvamLLMService, SarvamSTTService, SarvamRealtimeSTTService, SarvamTTSService, SarvamHttpTTSService), `@pipedog/smallest` (SmallestSTTService, SmallestTTSService), `@pipedog/gradium` (GradiumSTTService, GradiumTTSService), `@pipedog/meta` (MetaSTTService) and `@pipedog/inception` (InceptionLLMService), with docs. All run on Bun, Node, Deno and Cloudflare Workers: HTTP goes through `fetch` and WebSockets through the core `websocketConnect`, with no provider SDKs.

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
