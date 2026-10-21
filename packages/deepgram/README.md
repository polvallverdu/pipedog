# @pipedog/deepgram

Deepgram services for pipedog: streaming speech-to-text (`DeepgramSTTService`), WebSocket and HTTP
text-to-speech (`DeepgramTTSService`, `DeepgramHttpTTSService`), and Flux, Deepgram's
turn-taking STT (`DeepgramFluxSTTService`) and its TTS (`DeepgramFluxTTSService`). It talks to the
API with `fetch` and `WebSocket`; no Deepgram SDK is needed.

A port of Pipecat's `pipecat.services.deepgram`. Subpaths mirror upstream:
`@pipedog/deepgram/stt`, `/tts`, `/flux/stt`, `/flux/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/deepgram
```

No peer dependencies.

## Usage

```ts
import { DeepgramSTTService } from "@pipedog/deepgram/stt";
import { DeepgramTTSService } from "@pipedog/deepgram/tts";

const apiKey = process.env.DEEPGRAM_API_KEY ?? "";

const stt = new DeepgramSTTService({ apiKey });
const tts = new DeepgramTTSService({ apiKey, sampleRate: 24000 });
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

`DeepgramFluxSTTService` (`@pipedog/deepgram/flux/stt`) detects turns itself: use it with no VAD
analyzer and nothing runs locally.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

Not every upstream Deepgram module is ported yet (for example the SageMaker variants); see
[porting status](https://polvallverdu.github.io/pipedog/docs/contributing/status/).

## Links

- Docs: [turn detection](https://polvallverdu.github.io/pipedog/docs/turn-detection/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
