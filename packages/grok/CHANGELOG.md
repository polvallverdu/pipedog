# @pipedog/grok

## 0.7.0

### Patch Changes

- Updated dependencies []:
  - @pipedog/xai@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies []:
  - @pipedog/xai@0.6.1

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

- [#38](https://github.com/polvallverdu/pipedog/pull/38) [`28738f0`](https://github.com/polvallverdu/pipedog/commit/28738f09415336a6ec4aec6cbd285f5abb3578b0) Thanks [@polvallverdu](https://github.com/polvallverdu)! - xAI Grok Voice Agent speech-to-speech.
  
  - `@pipedog/xai`: `GrokRealtimeLLMService` (`@pipedog/xai/realtime/llm`) with its events
    (`@pipedog/xai/realtime/events`) and `GrokRealtimeLLMAdapter`: server VAD or locally driven
    turns, function calling and xAI's built-in tools, transcripts, audio truncation on interruption,
    `forceMessage()`, DTMF and MCP events.
  - `@pipedog/grok`: the deprecated `@pipedog/grok/realtime/*` aliases, and
    `@pipedog/grok/grok_realtime_adapter`.
  
  Runs on Bun, Node, Deno and Cloudflare Workers.

### Patch Changes

- Updated dependencies [[`7eeca04`](https://github.com/polvallverdu/pipedog/commit/7eeca04f5aa124575a8806051c5f6efe7b241c11), [`28738f0`](https://github.com/polvallverdu/pipedog/commit/28738f09415336a6ec4aec6cbd285f5abb3578b0)]:
  - @pipedog/xai@0.6.0
