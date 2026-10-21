# @pipedog/baseten

Baseten services for pipedog: `BasetenLLMService`, an LLM service for Baseten's OpenAI-compatible inference API (Model APIs, or a dedicated deployment). It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.baseten`. Subpaths mirror upstream: `@pipedog/baseten/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/baseten
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { BasetenLLMService } from "@pipedog/baseten/llm";

const llm = new BasetenLLMService({
  apiKey: process.env.BASETEN_API_KEY ?? "",
  settings: new BasetenLLMService.Settings({
    model: "zai-org/GLM-5.3",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [Baseten](https://polvallverdu.github.io/pipedog/docs/services/llm/baseten/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
