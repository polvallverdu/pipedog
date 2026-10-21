# @pipedog/together

Together AI services for pipedog: `TogetherLLMService` (chat completions, an `OpenAILLMService` subclass), `TogetherSTTService` (realtime transcription over WebSocket) and `TogetherTTSService` (speech synthesis over WebSocket).

A port of Pipecat's `pipecat.services.together`. Subpaths mirror upstream: `@pipedog/together/llm`, `@pipedog/together/stt`, `@pipedog/together/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/together
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: HTTP goes through `fetch` and WebSockets through
the core `websocketConnect`.

## Links

- Docs: [services](https://polvallverdu.github.io/pipedog/docs/services/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
