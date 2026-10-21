# @pipedog/mistral

Mistral services for pipedog: `MistralLLMService` (chat completions, an `OpenAILLMService` subclass, with `MistralLLMAdapter`), `MistralSTTService` (Voxtral realtime transcription) and `MistralTTSService` (Voxtral speech synthesis).

A port of Pipecat's `pipecat.adapters.services.mistral_adapter`, `pipecat.services.mistral`. Subpaths mirror upstream: `@pipedog/mistral/llm`, `@pipedog/mistral/mistral_adapter`, `@pipedog/mistral/stt`, `@pipedog/mistral/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/mistral
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: HTTP goes through `fetch` and WebSockets through
the core `websocketConnect`.

## Links

- Docs: [services](https://polvallverdu.github.io/pipedog/docs/services/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
