# @pipedog/whisper

The base speech-to-text service for Whisper-compatible APIs: `BaseWhisperSTTService` sends each
user utterance (segmented by VAD) to an OpenAI-style `audio/transcriptions` endpoint, through the
official `openai` JS SDK, and emits the transcript, with metrics and error handling. It is shared
by the pipedog STT services that speak the Whisper protocol, such as `OpenAISTTService` in
[`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai). Most apps use one of those and
never import this package directly.

A port of Pipecat's `pipecat.services.whisper.base_stt` (`@pipedog/whisper/base_stt`). Upstream's
local Whisper models (`pipecat.services.whisper.stt`) are not ported.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/whisper
```

No peer dependencies. Provider packages that need it depend on it, so it installs with them.

## Usage

```ts
import { BaseWhisperSTTService } from "@pipedog/whisper/base_stt";

// Any server that implements OpenAI's /audio/transcriptions API:
const stt = new BaseWhisperSTTService({
  apiKey: process.env.WHISPER_API_KEY ?? null,
  baseUrl: "http://localhost:8000/v1",
});
```

Subclass it, as `OpenAISTTService` does, to add provider-specific settings.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/),
  [coming from Pipecat](https://polvallverdu.github.io/pipedog/docs/coming-from-pipecat/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
