# @pipedog/mistral

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

- [#39](https://github.com/polvallverdu/pipedog/pull/39) [`153361f`](https://github.com/polvallverdu/pipedog/commit/153361f78cdec1d9a963b8e6acc64f54a54b7897) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `MistralSTTService` now speaks Mistral's realtime protocol as the SDK does: it waits for
  `session.created` before sending `session.update`, and sends `targetStreamingDelayMs` as the
  session's `target_streaming_delay_ms` instead of a query parameter. `error` events whose message is
  an object are reported in full.
- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0
  - @pipedog/openai@0.6.0
