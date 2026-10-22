# @pipedog/gladia

Gladia speech-to-text for pipedog: `GladiaSTTService`, a streaming STT service over Gladia's live
API (`POST /v2/live` to open a session, then a WebSocket for audio and transcripts). It uses
`fetch` and `WebSocket`; no Gladia SDK is needed.

A port of Pipecat's `pipecat.services.gladia`. Subpaths mirror upstream: `@pipedog/gladia/stt`,
`@pipedog/gladia/config`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/gladia
```

No peer dependencies.

## Usage

```ts
import { GladiaSTTService } from "@pipedog/gladia/stt";
import { LanguageConfig } from "@pipedog/gladia/config";

const stt = new GladiaSTTService({
  apiKey: process.env.GLADIA_API_KEY ?? "",
  region: "eu-west",
  settings: new GladiaSTTService.Settings({
    languageConfig: new LanguageConfig({ languages: ["en", "fr"], codeSwitching: true }),
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

With `enableVad: true` in the settings, Gladia's server-side VAD drives end-of-utterance detection
and the service asks for external user turn strategies, so run it without a local VAD analyzer.

The deprecated upstream `GladiaInputParams`, `params` and `model` constructor arguments are not
ported; use `settings`.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
