# @pipedog/soniox

Soniox services for pipedog: real-time speech-to-text (`SonioxSTTService`) and streaming
text-to-speech (`SonioxTTSService`). Both talk to Soniox's WebSocket APIs with the global
`WebSocket` (through core's `websocketConnect`); no Soniox SDK is needed.

A port of Pipecat's `pipecat.services.soniox`. Subpaths mirror upstream:
`@pipedog/soniox/stt`, `/tts`, `/errors`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/soniox
```

No peer dependencies.

## Usage

```ts
import { SonioxSTTService } from "@pipedog/soniox/stt";
import { SonioxTTSService } from "@pipedog/soniox/tts";

const apiKey = process.env.SONIOX_API_KEY ?? "";

const stt = new SonioxSTTService({ apiKey });
const tts = new SonioxTTSService({
  apiKey,
  settings: new SonioxTTSService.Settings({ voice: "Adrian" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

With `vadForceTurnEndpoint: false`, Soniox's own endpoint detection decides when the user's turn
ends and the service proposes the turn boundaries.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
