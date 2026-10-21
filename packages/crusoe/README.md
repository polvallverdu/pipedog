# @pipedog/crusoe

Crusoe services for pipedog: `CrusoeLLMService`, an LLM service for Crusoe Cloud's Managed Inference API. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.crusoe`. Subpaths mirror upstream: `@pipedog/crusoe/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/crusoe
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { CrusoeLLMService } from "@pipedog/crusoe/llm";

const llm = new CrusoeLLMService({
  apiKey: process.env.CRUSOE_API_KEY ?? "",
  settings: new CrusoeLLMService.Settings({
    model: "openai/gpt-oss-120b",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [Crusoe](https://polvallverdu.github.io/pipedog/docs/services/llm/crusoe/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
