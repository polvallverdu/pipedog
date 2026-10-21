# @pipedog/qwen

Qwen services for pipedog: `QwenLLMService`, an LLM service for Alibaba Cloud's Qwen models, through DashScope's OpenAI-compatible mode. It
extends `OpenAILLMService` from [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai),
so streaming, function calling, usage metrics and `runInference` work as they do there.

A port of Pipecat's `pipecat.services.qwen`. Subpaths mirror upstream: `@pipedog/qwen/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/qwen
```

It depends on `@pipedog/openai` (and the official `openai` JS SDK), which is installed with it.

## Usage

```ts
import { QwenLLMService } from "@pipedog/qwen/llm";

const llm = new QwenLLMService({
  apiKey: process.env.QWEN_API_KEY ?? "",
  settings: new QwenLLMService.Settings({
    model: "qwen-plus",
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the client talks through `fetch`.

## Links

- Docs: [Qwen](https://polvallverdu.github.io/pipedog/docs/services/llm/qwen/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
