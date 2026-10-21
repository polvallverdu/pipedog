# @pipedog/nebius

Nebius services for pipedog: `NebiusLLMService`, an LLM service for Nebius Token Factory's OpenAI-compatible API. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.nebius`. Subpaths mirror upstream: `@pipedog/nebius/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/nebius
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { NebiusLLMService } from "@pipedog/nebius/llm";

const llm = new NebiusLLMService({
  apiKey: process.env.NEBIUS_API_KEY ?? "",
  settings: new NebiusLLMService.Settings({
    model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [Nebius](https://polvallverdu.github.io/pipedog/docs/services/llm/nebius/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
