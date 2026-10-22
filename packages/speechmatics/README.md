# @pipedog/speechmatics

Speechmatics services for pipedog: real-time speech-to-text over the Agent STT WebSocket API
(`SpeechmaticsSTTService`) and HTTP text-to-speech (`SpeechmaticsTTSService`). Both talk to the API
with `fetch` and `WebSocket`; no Speechmatics SDK is needed.

A port of Pipecat's `pipecat.services.speechmatics`. Subpaths mirror upstream:
`@pipedog/speechmatics/stt` and `/tts`. Upstream uses the Python `speechmatics-agent-stt` SDK; its
protocol (the part Pipecat uses) is implemented in `@pipedog/speechmatics/agent_stt`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/speechmatics
```

No peer dependencies.

## Usage

```ts
import { SpeechmaticsSTTService } from "@pipedog/speechmatics/stt";
import { SpeechmaticsTTSService } from "@pipedog/speechmatics/tts";

const apiKey = process.env.SPEECHMATICS_API_KEY ?? "";

const stt = new SpeechmaticsSTTService({ apiKey });
const tts = new SpeechmaticsTTSService({ apiKey });
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

By default turns are driven by your pipeline's VAD (`TurnDetectionMode.EXTERNAL`): the service sends
`ForceEndOfUtterance` when the VAD reports the end of speech. Set
`turnDetectionMode: TurnDetectionMode.VAD` in the settings to let Speechmatics detect turns itself.

The STT service reads `SPEECHMATICS_API_KEY` and `SPEECHMATICS_RT_URL` from the environment when
`apiKey` / `baseUrl` are not given. Speechmatics accepts 8 kHz and 16 kHz audio. The TTS service
only produces 16 kHz audio.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

On Bun, Node.js and Deno the standard `WebSocket` does not expose the HTTP status of a rejected
handshake, so a bad API key is retried (three attempts) before it is reported as a permanent error.
On Cloudflare Workers the status is read and a bad key is permanent at once.

## Links

- Docs: [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
