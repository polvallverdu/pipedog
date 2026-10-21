# @pipedog/novita

Novita AI services for pipedog: `NovitaLLMService`, an LLM service for Novita AI's OpenAI-compatible API. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.novita`. Subpaths mirror upstream: `@pipedog/novita/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/novita
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { NovitaLLMService } from "@pipedog/novita/llm";

const llm = new NovitaLLMService({
  apiKey: process.env.NOVITA_API_KEY ?? "",
  settings: new NovitaLLMService.Settings({
    model: "moonshotai/kimi-k2.5",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [Novita AI](https://polvallverdu.github.io/pipedog/docs/services/llm/novita/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
