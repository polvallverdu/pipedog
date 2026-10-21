# @pipedog/grok

Grok services for pipedog: `GrokLLMService` and `GrokRealtimeLLMService`, re-exported from `@pipedog/xai/llm` and `@pipedog/xai/realtime/*`. These modules are deprecated upstream: import from `@pipedog/xai` instead. `@pipedog/grok/grok_realtime_adapter` re-exports `GrokRealtimeLLMAdapter`.

A port of Pipecat's `pipecat.services.grok` and `pipecat.adapters.services.grok_realtime_adapter`. Subpaths mirror upstream: `@pipedog/grok/llm`, `/realtime/llm`, `/realtime/events`, `/grok_realtime_adapter`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/grok
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: HTTP goes through `fetch` and WebSockets through
the core `websocketConnect`.

## Links

- Docs: [services](https://polvallverdu.github.io/pipedog/docs/services/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
