# @pipedog/minimax

MiniMax text-to-speech for pipedog: `MiniMaxHttpTTSService`, which streams audio from MiniMax's T2A
API with `fetch`.

A port of Pipecat's `pipecat.services.minimax`. Subpaths mirror upstream: `@pipedog/minimax/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/minimax
```

No peer dependencies.

## Usage

```ts
import { MiniMaxHttpTTSService } from "@pipedog/minimax/tts";

const tts = new MiniMaxHttpTTSService({
  apiKey: process.env.MINIMAX_API_KEY ?? "",
  groupId: process.env.MINIMAX_GROUP_ID ?? "",
  settings: new MiniMaxHttpTTSService.Settings({ model: "speech-2.8-turbo", voice: "Calm_Woman" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

Pass `fetch` to use your own HTTP client; it stands in for upstream's shared `aiohttp` session.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [MiniMax](https://polvallverdu.github.io/pipedog/docs/services/tts/minimax/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
