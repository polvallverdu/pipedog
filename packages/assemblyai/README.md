# @pipedog/assemblyai

AssemblyAI services for pipedog: streaming transcription over the Universal-Streaming v3
WebSocket API (`AssemblyAISTTService`), per-segment transcription over the Sync HTTP API
(`AssemblyAISyncSTTService`), and streaming text-to-speech with per-word timings over the
Streaming TTS WebSocket API (`AssemblyAITTSService`). They talk to the API with `fetch` and
`WebSocket`; no AssemblyAI SDK is needed.

A port of Pipecat's `pipecat.services.assemblyai`. Subpaths mirror upstream:
`@pipedog/assemblyai/stt`, `/tts`, `/models`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/assemblyai
```

No peer dependencies.

## Usage

```ts
import { AssemblyAISTTService } from "@pipedog/assemblyai/stt";

const stt = new AssemblyAISTTService({
  apiKey: process.env.ASSEMBLYAI_API_KEY ?? "",
  settings: new AssemblyAISTTService.Settings({
    model: "universal-3-6-pro",
    keytermsPrompt: ["pipedog", "Pipecat"],
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

By default Pipecat's own turn detection (VAD plus Smart Turn) decides when the user is done, and
the service sends `ForceEndpoint` when the VAD stops. Pass `vadForceTurnEndpoint: false` (U3 Pro
models only) to let AssemblyAI's model detect turns instead.

`AssemblyAISyncSTTService` transcribes each VAD-delimited segment with one HTTP request and carries
recent conversation context automatically. Pass `fetch` to use a custom `fetch`; it defaults to the
global one.

### Text-to-speech

```ts
import { AssemblyAITTSService } from "@pipedog/assemblyai/tts";

// Speaks in Audrey, the default voice. Pass a voice ID or a library slug such as "aai-jane".
const tts = new AssemblyAITTSService({
  apiKey: process.env.ASSEMBLYAI_API_KEY ?? "",
  settings: new AssemblyAITTSService.Settings({ voice: "aai-jane" }),
});
```

The service connects to the US host; pass `url: "wss://tts.eu.assemblyai.com/v1/ws"` to process
data in the EU. Interruptions cancel synthesis in flight without reconnecting, and the service
keeps an idle session open and replaces a session before its one-hour limit. Changing the voice,
language or model reconnects.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

Deprecated upstream APIs are not ported (`AssemblyAIConnectionParams`, the `language` and
`connectionParams` constructor options); use `settings`.

## Links

- Docs: [AssemblyAI STT](https://polvallverdu.github.io/pipedog/docs/services/stt/assemblyai/),
  [AssemblyAI TTS](https://polvallverdu.github.io/pipedog/docs/services/tts/assemblyai/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
