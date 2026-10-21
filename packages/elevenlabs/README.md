# @pipedog/elevenlabs

ElevenLabs services for pipedog: speech-to-text (`ElevenLabsSTTService`), realtime streaming STT
(`ElevenLabsRealtimeSTTService`), and WebSocket and HTTP text-to-speech (`ElevenLabsTTSService`,
`ElevenLabsHttpTTSService`) with word timestamps. It talks to the API with `fetch` and `WebSocket`;
no ElevenLabs SDK is needed.

A port of Pipecat's `pipecat.services.elevenlabs`. Subpaths mirror upstream:
`@pipedog/elevenlabs/stt`, `/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/elevenlabs
```

No peer dependencies.

## Usage

```ts
import { ElevenLabsTTSService } from "@pipedog/elevenlabs/tts";

const tts = new ElevenLabsTTSService({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  settings: new ElevenLabsTTSService.Settings({ voice: "<voice id>", stability: 0.5 }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

Upstream's Text-to-Dialogue service (`pipecat.services.elevenlabs.dialogue`) is not ported yet; see
[porting status](https://polvallverdu.github.io/pipedog/docs/contributing/status/).

## Links

- Docs: [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/) (swap the TTS),
  [coming from Pipecat](https://polvallverdu.github.io/pipedog/docs/coming-from-pipecat/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
