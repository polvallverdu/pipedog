# @pipedog/xai

xAI services for pipedog: `GrokLLMService` (chat completions, an `OpenAILLMService` subclass), `XAISTTService` (realtime transcription over WebSocket) and `XAITTSService` / `XAIHttpTTSService` (speech synthesis), and `GrokRealtimeLLMService` (speech-to-speech over the Grok Voice Agent API).

A port of Pipecat's `pipecat.services.xai` (`llm`, `stt`, `tts`, `realtime`) and its Grok Realtime adapter. Subpaths mirror upstream: `@pipedog/xai/llm`, `@pipedog/xai/stt`, `@pipedog/xai/tts`, `@pipedog/xai/realtime/llm`, `@pipedog/xai/realtime/events`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/xai
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: HTTP goes through `fetch` and WebSockets through
the core `websocketConnect`.

## Links

- Docs: [services](https://polvallverdu.github.io/pipedog/docs/services/),
  [xAI Grok Realtime](https://polvallverdu.github.io/pipedog/docs/services/s2s/grok/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
