# @pipedog/inworld

Inworld services for pipedog: the Realtime speech-to-speech API (`InworldRealtimeLLMService`),
and WebSocket and HTTP text-to-speech (`InworldTTSService`, `InworldHttpTTSService`). It talks to
the API with `fetch` and `WebSocket`; no Inworld SDK is needed.

A port of Pipecat's `pipecat.services.inworld` and its Realtime adapter. Subpaths mirror
upstream: `@pipedog/inworld/tts`, `/realtime/llm`, `/realtime/events`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/inworld
```

No peer dependencies.

## Usage

```ts
import { InworldRealtimeLLMService } from "@pipedog/inworld/realtime/llm";

const llm = new InworldRealtimeLLMService({
  apiKey: process.env.INWORLD_API_KEY ?? "",
  llmModel: "openai/gpt-4.1-mini",
  voice: "Sarah",
  ttsModel: "inworld-tts-2",
});
// new Pipeline([transport.input(), userAggregator, llm, transport.output(), assistantAggregator])
```

```ts
import { InworldTTSService } from "@pipedog/inworld/tts";

const tts = new InworldTTSService({ apiKey: process.env.INWORLD_API_KEY ?? "" });
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [Inworld Realtime](https://polvallverdu.github.io/pipedog/docs/services/s2s/inworld/),
  [Inworld TTS](https://polvallverdu.github.io/pipedog/docs/services/tts/inworld/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
