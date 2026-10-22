# @pipedog/gradium

Gradium services for pipedog: real-time speech-to-text (`GradiumSTTService`, with optional turn
detection from the server's end-pointing signal) and streaming text-to-speech
(`GradiumTTSService`). It talks to the API with the global `WebSocket`; no Gradium SDK is needed.

A port of Pipecat's `pipecat.services.gradium`. Subpaths mirror upstream:
`@pipedog/gradium/stt`, `@pipedog/gradium/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/gradium
```

No peer dependencies.

## Usage

```ts
import { GradiumSTTService } from "@pipedog/gradium/stt";
import { GradiumTTSService } from "@pipedog/gradium/tts";

const apiKey = process.env.GRADIUM_API_KEY ?? "";

const stt = new GradiumSTTService({ apiKey });
const tts = new GradiumTTSService({ apiKey });
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

Pass `enableTurnDetection: true` to `GradiumSTTService` to let Gradium's end-pointing signal decide
when the user's turn starts and ends; the service then recommends `ExternalUserTurnStrategies`.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: the WebSocket goes through the core
`websocketConnect`, which sends the `x-api-key` header on every runtime.

## Links

- Docs: [services](https://polvallverdu.github.io/pipedog/docs/services/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
