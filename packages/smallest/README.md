# @pipedog/smallest

Smallest AI services for pipedog: real-time speech-to-text over the Pulse WebSocket API
(`SmallestSTTService`, models `pulse` and `pulse-2`) and streaming text-to-speech over the Waves
WebSocket API (`SmallestTTSService`, Lightning v3.1 models, with per-word timestamps). It talks to
the API with the global `WebSocket`; no Smallest SDK is needed.

A port of Pipecat's `pipecat.services.smallest`. Subpaths mirror upstream:
`@pipedog/smallest/stt` and `@pipedog/smallest/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/smallest
```

No peer dependencies.

## Usage

```ts
import { SmallestSTTService } from "@pipedog/smallest/stt";
import { SmallestTTSService } from "@pipedog/smallest/tts";

const apiKey = process.env.SMALLEST_API_KEY ?? "";

const stt = new SmallestSTTService({ apiKey });
const tts = new SmallestTTSService({ apiKey });
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: WebSockets go through the core
`websocketConnect`, which sends the `Authorization` header on every runtime.

## Links

- Docs: [services](https://polvallverdu.github.io/pipedog/docs/services/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
