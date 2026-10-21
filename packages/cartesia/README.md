# @pipedog/cartesia

Cartesia services for pipedog: streaming speech-to-text (`CartesiaSTTService`), Ink-2 turn-based
STT (`CartesiaTurnsSTTService`), and WebSocket and HTTP text-to-speech (`CartesiaTTSService`,
`CartesiaHttpTTSService`) with word timestamps. It talks to the API with `fetch` and `WebSocket`; no
Cartesia SDK is needed.

A port of Pipecat's `pipecat.services.cartesia`. Subpaths mirror upstream:
`@pipedog/cartesia/stt`, `/tts`, `/turns/stt`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/cartesia
```

No peer dependencies.

## Usage

```ts
import { CartesiaSTTService } from "@pipedog/cartesia/stt";
import { CartesiaTTSService } from "@pipedog/cartesia/tts";

const apiKey = process.env.CARTESIA_API_KEY ?? "";

const stt = new CartesiaSTTService({ apiKey });
const tts = new CartesiaTTSService({
  apiKey,
  settings: new CartesiaTTSService.Settings({ voice: "<voice id>" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

`CartesiaTurnsSTTService` (`@pipedog/cartesia/turns/stt`) detects turns itself: use it with no VAD
analyzer and nothing runs locally.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [turn detection](https://polvallverdu.github.io/pipedog/docs/turn-detection/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
