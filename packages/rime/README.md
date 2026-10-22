# @pipedog/rime

Rime text-to-speech for pipedog: the JSON WebSocket service with word timestamps (`RimeTTSService`),
the HTTP service (`RimeHttpTTSService`) and the WebSocket v1 service (`RimeV1TTSService`, protobuf
envelopes). The WebSocket and HTTP services use `WebSocket` and `fetch`; WebSocket v1 uses Rime's
own `@rimelabs/api` messages.

A port of Pipecat's `pipecat.services.rime`. Subpaths mirror upstream: `@pipedog/rime/tts`, `/tts_v1`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/rime
```

No peer dependencies.

## Usage

```ts
import { RimeTTSService } from "@pipedog/rime/tts";

const tts = new RimeTTSService({
  apiKey: process.env.RIME_API_KEY ?? "",
  settings: new RimeTTSService.Settings({ model: "coda", voice: "<voice>" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

`RimeNonJsonTTSService` is deprecated upstream and is not ported.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Rime](https://polvallverdu.github.io/pipedog/docs/services/tts/rime/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
