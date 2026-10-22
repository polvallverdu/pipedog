# @pipedog/bland

Bland text-to-speech for pipedog: the realtime WebSocket service (`BlandTTSService`, LLM tokens
streamed in, barge-in sent as `cancel`) and the HTTP service (`BlandHttpTTSService`).

A port of Pipecat's `pipecat.services.bland`. Subpaths mirror upstream: `@pipedog/bland/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/bland
```

No peer dependencies.

## Usage

```ts
import { BlandTTSService } from "@pipedog/bland/tts";

const tts = new BlandTTSService({
  apiKey: process.env.BLAND_API_KEY ?? "",
  settings: new BlandTTSService.Settings({ voice: "<voice-id>" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

Pass `fetch` to use your own HTTP client; it stands in for upstream's shared `aiohttp` session.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Bland](https://polvallverdu.github.io/pipedog/docs/services/tts/bland/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
