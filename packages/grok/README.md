# @pipedog/grok

Grok services for pipedog: `GrokLLMService`, re-exported from `@pipedog/xai/llm`. It is deprecated upstream: import from `@pipedog/xai/llm` instead.

A port of Pipecat's `pipecat.services.grok.llm`. Subpaths mirror upstream: `@pipedog/grok/llm`.

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
