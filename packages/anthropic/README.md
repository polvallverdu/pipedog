# @pipedog/anthropic

Anthropic services for pipedog: `AnthropicLLMService`, a Claude LLM service with streaming, function
calling, prompt caching and extended thinking, and `AnthropicLLMAdapter`, which converts the
universal `LLMContext` to Anthropic's message format. It uses the official `@anthropic-ai/sdk`,
installed as a dependency.

A port of Pipecat's `pipecat.services.anthropic` and
`pipecat.adapters.llm.services.anthropic_adapter`. Subpaths mirror upstream:
`@pipedog/anthropic/llm` and `@pipedog/anthropic/anthropic_adapter`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/anthropic
```

No peer dependencies.

## Usage

```ts
import { AnthropicLLMService, AnthropicLLMSettings } from "@pipedog/anthropic/llm";

const llm = new AnthropicLLMService({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  settings: new AnthropicLLMSettings({
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

It drops into a pipeline wherever an OpenAI or Google LLM service would, between the user context
aggregator and the TTS service.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/) (swap the LLM),
  [coming from Pipecat](https://polvallverdu.github.io/pipedog/docs/coming-from-pipecat/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
