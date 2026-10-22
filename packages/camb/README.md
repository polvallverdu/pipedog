# @pipedog/camb

Camb.ai text-to-speech for pipedog: `CambTTSService` for the MARS models (`mars-flash`,
`mars-pro`), streaming audio from Camb's HTTP endpoint with `fetch`.

A port of Pipecat's `pipecat.services.camb`. Subpaths mirror upstream: `@pipedog/camb/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/camb
```

No peer dependencies.

## Usage

```ts
import { CambTTSService } from "@pipedog/camb/tts";

const tts = new CambTTSService({
  apiKey: process.env.CAMB_API_KEY ?? "",
  settings: new CambTTSService.Settings({ model: "mars-pro", voice: 147320 }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

Upstream calls Camb's Python SDK. pipedog calls the streaming endpoint directly, and adds a `baseUrl`
option in place of the SDK's `base_url` / `environment`.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Camb.ai](https://polvallverdu.github.io/pipedog/docs/services/tts/camb/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
