# @pipedog/fish

Fish Audio text-to-speech for pipedog: `FishAudioTTSService` streams over Fish Audio's MessagePack
WebSocket API. It uses `WebSocket` and `@msgpack/msgpack`; no Fish Audio SDK is needed.

A port of Pipecat's `pipecat.services.fish`. Subpaths mirror upstream: `@pipedog/fish/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/fish
```

No peer dependencies.

## Usage

```ts
import { FishAudioTTSService } from "@pipedog/fish/tts";

const tts = new FishAudioTTSService({
  apiKey: process.env.FISH_API_KEY ?? "",
  settings: new FishAudioTTSService.Settings({ voice: "<reference id>" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Fish Audio](https://polvallverdu.github.io/pipedog/docs/services/tts/fish/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
