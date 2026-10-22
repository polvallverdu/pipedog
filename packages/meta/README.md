# @pipedog/meta

Meta services for pipedog: `MetaSTTService`, real-time speech-to-text over the Muse Voice
realtime transcription WebSocket API. It talks to the API with the global `WebSocket`; no Meta SDK
is needed.

A port of Pipecat's `pipecat.services.meta`. The subpath mirrors upstream: `@pipedog/meta/stt`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/meta
```

No peer dependencies.

## Usage

```ts
import { MetaSTTService } from "@pipedog/meta/stt";

const stt = new MetaSTTService({ apiKey: process.env.META_API_KEY ?? "" });
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

The API key travels in the session handshake frame, not an HTTP header. Audio at anything other
than 24 kHz is resampled to 16 kHz, the only other rate the API accepts.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [services](https://polvallverdu.github.io/pipedog/docs/services/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
