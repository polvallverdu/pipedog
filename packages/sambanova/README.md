# @pipedog/sambanova

SambaNova services for pipedog: `SambaNovaLLMService`, an LLM service for SambaNova Cloud's OpenAI-compatible API. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.sambanova`. Subpaths mirror upstream: `@pipedog/sambanova/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/sambanova
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { SambaNovaLLMService } from "@pipedog/sambanova/llm";

const llm = new SambaNovaLLMService({
  apiKey: process.env.SAMBANOVA_API_KEY ?? "",
  settings: new SambaNovaLLMService.Settings({
    model: "Meta-Llama-3.3-70B-Instruct",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [SambaNova](https://polvallverdu.github.io/pipedog/docs/services/llm/sambanova/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
