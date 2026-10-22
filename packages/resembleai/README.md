# @pipedog/resembleai

Resemble AI text-to-speech for pipedog: `ResembleAITTSService` over WebSocket, with word
timestamps.

A port of Pipecat's `pipecat.services.resembleai`. Subpaths mirror upstream: `@pipedog/resembleai/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/resembleai
```

No peer dependencies.

## Usage

```ts
import { ResembleAITTSService } from "@pipedog/resembleai/tts";

const tts = new ResembleAITTSService({
  apiKey: process.env.RESEMBLE_API_KEY ?? "",
  projectUuid: process.env.RESEMBLE_PROJECT_UUID ?? null,
  settings: new ResembleAITTSService.Settings({ voice: "<voice-uuid>" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

`projectUuid` is not an upstream option. Resemble's WebSocket reference lists the project as
required, so pipedog lets you pass it.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Resemble AI](https://polvallverdu.github.io/pipedog/docs/services/tts/resembleai/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
