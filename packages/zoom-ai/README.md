# @pipedog/zoom-ai

Zoom AI speech-to-text for pipedog: `ZoomAISTTService`, a streaming STT service over Zoom's Scribe
Live WebSocket API. Scribe's own voice activity detection ends each turn and returns its final
transcript. It uses `WebSocket`; no Zoom SDK is needed.

A port of Pipecat's `pipecat.services.zoom_ai`. The subpath mirrors upstream:
`@pipedog/zoom-ai/stt`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/zoom-ai
```

No peer dependencies.

## Usage

```ts
import { Language } from "@pipedog/core/transcriptions/language";
import { ZoomAISTTService } from "@pipedog/zoom-ai/stt";

const stt = new ZoomAISTTService({
  apiKey: process.env.ZOOM_AI_API_KEY ?? "",
  settings: new ZoomAISTTService.Settings({
    language: Language.EN_US,
    vocabulary: ["pipedog", "Pipecat"],
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

Scribe decides when the user starts and stops speaking: the service pushes
`ProposedUserStartedSpeakingFrame` / `ProposedUserStoppedSpeakingFrame` around each final
`TranscriptionFrame` and recommends `ExternalUserTurnStrategies`, so the user aggregator follows
Scribe's turns. The settings (`silenceDurationMs`, default 350 ms; `diarization`,
`languageDetection`, `vocabulary`, `textPolishing`, and `extra` for other Scribe fields) map to the
Scribe API fields of the same name; changing one reconnects with a new session.

## Runtimes

Bun, Node.js 22+ and Cloudflare Workers.

A standard `WebSocket` exposes neither the handshake's HTTP status nor its body, so when Zoom
refuses the connection, its reason is reported only if the connect error carries the response (a
custom `webSocketFactory` can provide it).

## Links

- Docs: [Zoom AI](https://polvallverdu.github.io/pipedog/docs/services/stt/zoom-ai/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
