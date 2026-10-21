# @pipedog/azure

Azure services for pipedog:

- Azure OpenAI: chat completions (`AzureLLMService`), realtime speech-to-speech
  (`AzureRealtimeLLMService`) and image generation (`AzureImageGenServiceREST`). The LLM and
  realtime services reuse `@pipedog/openai`'s, with Azure endpoints and auth.
- Azure Voice Live (`AzureVoiceLiveLLMService`): Azure's realtime speech-to-speech API.
- Azure Speech: speech-to-text (`AzureSTTService`) and text-to-speech (`AzureTTSService`, with
  word timestamps, and `AzureHttpTTSService`).

Every service accepts an API key; the Azure OpenAI and Voice Live services also accept a
Microsoft Entra ID token provider (`AzureTokenProvider`, any `() => Promise<string>`).

A port of Pipecat's `pipecat.services.azure`. Subpaths mirror upstream: `@pipedog/azure/llm`,
`/image`, `/stt`, `/tts`, `/realtime/llm`, `/voice_live/llm`, `/voice_live/events`, `/common`,
and `/azure_voice_live_adapter`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/azure
```

## Usage

```ts
import { AzureLLMService } from "@pipedog/azure/llm";
import { AzureSTTService } from "@pipedog/azure/stt";
import { AzureTTSService } from "@pipedog/azure/tts";

const stt = new AzureSTTService({ apiKey: process.env.AZURE_SPEECH_API_KEY ?? "", region: "eastus" });
const llm = new AzureLLMService({
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  endpoint: "https://my-resource.openai.azure.com/openai/v1",
  settings: new AzureLLMService.Settings({ model: "my-deployment" }),
});
const tts = new AzureTTSService({ apiKey: process.env.AZURE_SPEECH_API_KEY ?? "", region: "eastus" });
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers, for every class. No Azure SDK is needed: Azure
OpenAI goes through the `openai` JS SDK (`fetch`), and Azure Speech, Realtime and Voice Live talk
to the services' REST and WebSocket protocols directly (`fetch` and core's `websocketConnect`).
The WebSocket services send their key in a header, so they are meant for servers, not browsers.

## Links

- Docs: [Azure OpenAI](https://polvallverdu.github.io/pipedog/docs/services/llm/azure/),
  [Azure Speech STT](https://polvallverdu.github.io/pipedog/docs/services/stt/azure/),
  [Azure Speech TTS](https://polvallverdu.github.io/pipedog/docs/services/tts/azure/),
  [Azure OpenAI Realtime](https://polvallverdu.github.io/pipedog/docs/services/s2s/azure-realtime/),
  [Azure Voice Live](https://polvallverdu.github.io/pipedog/docs/services/s2s/azure-voice-live/),
  [image generation](https://polvallverdu.github.io/pipedog/docs/services/image/azure/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
