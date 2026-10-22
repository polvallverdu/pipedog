# @pipedog/speechify

Speechify text-to-speech for pipedog: `SpeechifyHttpTTSService`, which streams audio and word
timestamps over server-sent events with `fetch`.

A port of Pipecat's `pipecat.services.speechify`. Subpaths mirror upstream: `@pipedog/speechify/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/speechify
```

No peer dependencies.

## Usage

```ts
import { SpeechifyHttpTTSService } from "@pipedog/speechify/tts";

const tts = new SpeechifyHttpTTSService({
  apiKey: process.env.SPEECHIFY_API_KEY ?? "",
  settings: new SpeechifyHttpTTSService.Settings({ model: "simba-3.2", voice: "geffen_32" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

Pass `fetch` to use your own HTTP client; it stands in for upstream's shared `aiohttp` session.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Speechify](https://polvallverdu.github.io/pipedog/docs/services/tts/speechify/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
