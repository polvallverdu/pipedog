# @pipedog/neuphonic

Neuphonic text-to-speech for pipedog: the WebSocket service (`NeuphonicTTSService`) and the
server-sent events service (`NeuphonicHttpTTSService`).

A port of Pipecat's `pipecat.services.neuphonic`. Subpaths mirror upstream: `@pipedog/neuphonic/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/neuphonic
```

No peer dependencies.

## Usage

```ts
import { NeuphonicTTSService } from "@pipedog/neuphonic/tts";

const tts = new NeuphonicTTSService({
  apiKey: process.env.NEUPHONIC_API_KEY ?? "",
  settings: new NeuphonicTTSService.Settings({ voice: "<voice-id>" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

Pass `fetch` to use your own HTTP client; it stands in for upstream's shared `aiohttp` session.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Neuphonic](https://polvallverdu.github.io/pipedog/docs/services/tts/neuphonic/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
