# @pipedog/cerebras

Cerebras services for pipedog: `CerebrasLLMService`, an LLM service for Cerebras's OpenAI-compatible inference API. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.cerebras`. Subpaths mirror upstream: `@pipedog/cerebras/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/cerebras
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { CerebrasLLMService } from "@pipedog/cerebras/llm";

const llm = new CerebrasLLMService({
  apiKey: process.env.CEREBRAS_API_KEY ?? "",
  settings: new CerebrasLLMService.Settings({
    model: "gpt-oss-120b",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [Cerebras](https://polvallverdu.github.io/pipedog/docs/services/llm/cerebras/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
