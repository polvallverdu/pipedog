# @pipedog/sarvam

Sarvam AI services for pipedog: the chat LLM (`SarvamLLMService`, OpenAI-compatible), speech-to-text
(`SarvamSTTService`, and `SarvamRealtimeSTTService` over WebSocket) and text-to-speech
(`SarvamTTSService` over WebSocket, `SarvamHttpTTSService` over HTTP).

A port of Pipecat's `pipecat.services.sarvam`. Subpaths mirror upstream: `@pipedog/sarvam/llm`, `/stt`, `/tts`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/sarvam
```

`@pipedog/openai` installs with it (the LLM extends `OpenAILLMService`). No peer dependencies.

## Usage

```ts
import { SarvamLLMService } from "@pipedog/sarvam/llm";
import { SarvamSTTService } from "@pipedog/sarvam/stt";
import { SarvamTTSService } from "@pipedog/sarvam/tts";

const stt = new SarvamSTTService({ apiKey: process.env.SARVAM_API_KEY ?? "" });
const llm = new SarvamLLMService({ apiKey: process.env.SARVAM_API_KEY ?? "" });
const tts = new SarvamTTSService({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  settings: new SarvamTTSService.Settings({ model: "bulbul:v3", voice: "shubh" }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

Upstream drives Sarvam's `sarvamai` Python SDK for speech-to-text. pipedog speaks the same WebSocket
protocol directly, and `SarvamSTTService` takes a `baseUrl` option because the SDK hardcodes it.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers.

## Links

- Docs: [LLM](https://polvallverdu.github.io/pipedog/docs/services/llm/sarvam/), [STT](https://polvallverdu.github.io/pipedog/docs/services/stt/sarvam/), [TTS](https://polvallverdu.github.io/pipedog/docs/services/tts/sarvam/),
  [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
