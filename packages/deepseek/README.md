# @pipedog/deepseek

DeepSeek services for pipedog: `DeepSeekLLMService`, an LLM service for DeepSeek's chat API, with thinking mode control, and `DeepSeekLLMAdapter`, which shapes the messages to the provider's rules. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.deepseek` and `pipecat.adapters.services.deepseek_adapter`. Subpaths mirror upstream: `@pipedog/deepseek/llm` and `@pipedog/deepseek/deepseek_adapter`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/deepseek
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { DeepSeekLLMService } from "@pipedog/deepseek/llm";

const llm = new DeepSeekLLMService({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  settings: new DeepSeekLLMService.Settings({
    model: "deepseek-flash",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [DeepSeek](https://polvallverdu.github.io/pipedog/docs/services/llm/deepseek/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
