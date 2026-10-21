# @pipedog/fireworks

Fireworks AI services for pipedog: `FireworksLLMService`, an LLM service for Fireworks AI's OpenAI-compatible inference API. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.fireworks`. Subpaths mirror upstream: `@pipedog/fireworks/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/fireworks
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { FireworksLLMService } from "@pipedog/fireworks/llm";

const llm = new FireworksLLMService({
  apiKey: process.env.FIREWORKS_API_KEY ?? "",
  settings: new FireworksLLMService.Settings({
    model: "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [Fireworks AI](https://polvallverdu.github.io/pipedog/docs/services/llm/fireworks/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
