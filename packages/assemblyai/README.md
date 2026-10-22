# @pipedog/assemblyai

AssemblyAI speech-to-text for pipedog: streaming transcription over the Universal-Streaming v3
WebSocket API (`AssemblyAISTTService`) and per-segment transcription over the Sync HTTP API
(`AssemblyAISyncSTTService`). Both talk to the API with `fetch` and `WebSocket`; no AssemblyAI SDK
is needed.

A port of Pipecat's `pipecat.services.assemblyai`. Subpaths mirror upstream:
`@pipedog/assemblyai/stt`, `/models`.

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

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

Deprecated upstream APIs are not ported (`AssemblyAIConnectionParams`, the `language` and
`connectionParams` constructor options); use `settings`.

## Links

- Docs: [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
