# @pipedog/openrouter

OpenRouter services for pipedog: `OpenRouterLLMService`, an LLM service for OpenRouter's API, with provider routing preferences. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.openrouter`. Subpaths mirror upstream: `@pipedog/openrouter/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/openrouter
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";

const llm = new OpenRouterLLMService({
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  settings: new OpenRouterLLMService.Settings({
    model: "openai/gpt-4.1",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [OpenRouter](https://polvallverdu.github.io/pipedog/docs/services/llm/openrouter/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
