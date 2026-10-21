# @pipedog/ultravox

The Ultravox Realtime speech-to-speech service for pipedog (`UltravoxRealtimeLLMService`).
It creates a call over the Ultravox REST API with `fetch` (or joins one by URL) and streams audio
over a `WebSocket`; no Ultravox SDK is needed.

A port of Pipecat's `pipecat.services.ultravox`. The subpath mirrors upstream:
`@pipedog/ultravox/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/ultravox
```

No peer dependencies.

## Usage

```ts
import { OneShotInputParams, UltravoxRealtimeLLMService } from "@pipedog/ultravox/llm";

const llm = new UltravoxRealtimeLLMService({
  params: new OneShotInputParams({
    apiKey: process.env.ULTRAVOX_API_KEY ?? "",
    systemPrompt: "You are a helpful voice assistant.",
  }),
});
// new Pipeline([transport.input(), userAggregator, llm, transport.output(), assistantAggregator])
```

`AgentInputParams` starts a call with an agent configured in the Ultravox console, and
`JoinUrlInputParams` joins a call you created yourself.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Ultravox](https://polvallverdu.github.io/pipedog/docs/services/s2s/ultravox/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
