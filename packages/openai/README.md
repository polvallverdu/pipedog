# @pipedog/openai

OpenAI services for pipedog: the chat completions LLM (`OpenAILLMService`), the Responses API
(`OpenAIResponsesLLMService`), Realtime (`OpenAIRealtimeLLMService`), Live, speech-to-text
(`OpenAISTTService`, and `OpenAIRealtimeSTTService` with server-side turn detection),
text-to-speech (`OpenAITTSService`) and image generation (`OpenAIImageGenService`). It uses the
official `openai` JS SDK (installed as a dependency), and `baseUrl` points it at OpenAI-compatible
servers.

A port of Pipecat's `pipecat.services.openai` and the OpenAI adapters in
`pipecat.adapters.services`. Subpaths mirror upstream: `@pipedog/openai/llm`, `/stt`, `/tts`,
`/realtime/llm`, `/live/llm`, `/responses/llm`, `/image`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/openai
```

It depends on [`@pipedog/whisper`](https://www.npmjs.com/package/@pipedog/whisper), which is
installed with it.

## Usage

```ts
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";

const apiKey = process.env.OPENAI_API_KEY ?? null;

const stt = new OpenAISTTService({ apiKey });
const llm = new OpenAILLMService({
  apiKey,
  settings: new OpenAILLMSettings({ systemInstruction: "You are a helpful voice assistant." }),
});
const tts = new OpenAITTSService({ apiKey, sampleRate: 24000 });
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/),
  [turn detection](https://polvallverdu.github.io/pipedog/docs/turn-detection/) (realtime STT turns),
  [Workers](https://polvallverdu.github.io/pipedog/docs/workers/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
