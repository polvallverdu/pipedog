# @pipedog/ollama

Ollama services for pipedog: `OLLamaLLMService`, an LLM service for models running locally with Ollama. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.ollama`. Subpaths mirror upstream: `@pipedog/ollama/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/ollama
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { OLLamaLLMService } from "@pipedog/ollama/llm";

const llm = new OLLamaLLMService({
  settings: new OLLamaLLMService.Settings({
    model: "llama2",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [Ollama](https://polvallverdu.github.io/pipedog/docs/services/llm/ollama/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
