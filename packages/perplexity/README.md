# @pipedog/perplexity

Perplexity services for pipedog: `PerplexityAgentHttpLLMService`, an LLM service for Perplexity's
Agent API (web search over the OpenAI Responses protocol), and `PerplexityLLMAdapter`. The service
extends `OpenAIResponsesHttpLLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there. Upstream's
`PerplexityLLMService` (Sonar chat completions) is deprecated and not ported.

A port of Pipecat's `pipecat.services.perplexity` and `pipecat.adapters.llm.services.perplexity_adapter`. Subpaths mirror upstream: `@pipedog/perplexity/llm` and `@pipedog/perplexity/perplexity_adapter`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/perplexity
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { PerplexityAgentHttpLLMService } from "@pipedog/perplexity/llm";

const llm = new PerplexityAgentHttpLLMService({
  apiKey: process.env.PERPLEXITY_API_KEY ?? "",
  settings: new PerplexityAgentHttpLLMService.Settings({
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
