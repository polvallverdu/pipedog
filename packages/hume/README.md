# @pipedog/hume

Hume text-to-speech for pipedog: `HumeTTSService` streams Octave audio and word timestamps from
Hume's `tts/stream/json` endpoint. It uses `fetch`; the Hume SDK is not needed.

A port of Pipecat's `pipecat.services.hume`. Subpaths mirror upstream: `@pipedog/hume/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/hume
```

No peer dependencies.

## Usage

```ts
import { HumeTTSService } from "@pipedog/hume/tts";

const tts = new HumeTTSService({
  apiKey: process.env.HUME_API_KEY,
  settings: new HumeTTSService.Settings({ voice: "<voice id>" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Hume](https://polvallverdu.github.io/pipedog/docs/services/tts/hume/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
