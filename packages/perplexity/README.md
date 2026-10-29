# @pipedog/perplexity

Perplexity services for pipedog: `PerplexityLLMService`, an LLM service for Perplexity's Sonar API, and `PerplexityLLMAdapter`, which shapes the messages to the provider's rules. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.perplexity` and `pipecat.adapters.llm.services.perplexity_adapter`. Subpaths mirror upstream: `@pipedog/perplexity/llm` and `@pipedog/perplexity/perplexity_adapter`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/perplexity
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { PerplexityLLMService } from "@pipedog/perplexity/llm";

const llm = new PerplexityLLMService({
  apiKey: process.env.PERPLEXITY_API_KEY ?? "",
  settings: new PerplexityLLMService.Settings({
    model: "sonar",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [Perplexity](https://polvallverdu.github.io/pipedog/docs/services/llm/perplexity/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
