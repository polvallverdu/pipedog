# @pipedog/asyncai

Async text-to-speech for pipedog: the WebSocket service (`AsyncAITTSService`) and the HTTP service
(`AsyncAIHttpTTSService`). Both use `WebSocket` and `fetch`.

A port of Pipecat's `pipecat.services.asyncai`. Subpaths mirror upstream: `@pipedog/asyncai/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/asyncai
```

No peer dependencies.

## Usage

```ts
import { AsyncAITTSService } from "@pipedog/asyncai/tts";

const tts = new AsyncAITTSService({
  apiKey: process.env.ASYNC_API_KEY ?? "",
  settings: new AsyncAITTSService.Settings({ voice: "<voice-uuid>" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

Pass `fetch` to use your own HTTP client; it stands in for upstream's shared `aiohttp` session.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Async](https://polvallverdu.github.io/pipedog/docs/services/tts/asyncai/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
