# @pipedog/groq

Groq services for pipedog: `GroqLLMService` (chat completions, an `OpenAILLMService` subclass), `GroqSTTService` (Whisper models, a `BaseWhisperSTTService` subclass) and `GroqTTSService` (speech synthesis over Groq's OpenAI-compatible HTTP API).

A port of Pipecat's `pipecat.services.groq`. Subpaths mirror upstream: `@pipedog/groq/llm`, `@pipedog/groq/stt`, `@pipedog/groq/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/groq
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: HTTP goes through `fetch` and WebSockets through
the core `websocketConnect`.

## Links

- Docs: [services](https://polvallverdu.github.io/pipedog/docs/services/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
