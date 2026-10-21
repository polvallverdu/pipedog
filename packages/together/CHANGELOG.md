# @pipedog/together

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
