# @pipedog/cloudflare

Cloudflare Workers AI services for pipedog, so a voice agent can run its whole stack on Cloudflare:

| Service | Workers AI model | Kind |
| --- | --- | --- |
| `WorkersAIFluxSTTService` | `@cf/deepgram/flux` | STT with turn detection (WebSocket) |
| `WorkersAINova3STTService` | `@cf/deepgram/nova-3` | streaming STT (WebSocket) |
| `WorkersAIWhisperSTTService` | `@cf/openai/whisper-large-v3-turbo`, `whisper`, `whisper-tiny-en` | segmented STT |
| `WorkersAIAuraTTSService` | `@cf/deepgram/aura-2-en`, `aura-2-es`, `aura-1` | streaming TTS (WebSocket) |
| `WorkersAIAuraHttpTTSService` | the same | TTS, one request per sentence |
| `WorkersAIMeloTTSService` | `@cf/myshell-ai/melotts` | TTS, one request per sentence (MP3; pass a decoder) |
| `WorkersAILLMService` | any chat model, e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | LLM (OpenAI-compatible endpoint) |
| `WorkersAISmartTurnAnalyzer` | `@cf/pipecat-ai/smart-turn-v2` | turn analyzer |

This package is pipedog's own: Pipecat has no Workers AI services. The Flux, Nova-3 and Aura
services reuse `@pipedog/deepgram`, since Workers AI carries Deepgram's WebSocket protocols.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/cloudflare
```

## Usage

Every service reaches Workers AI through the Worker's `AI` binding, or anywhere through the REST API
with an account ID and an API token (Workers AI permission). The LLM uses the REST API in both cases.

```ts
import { WorkersAIFluxSTTService } from "@pipedog/cloudflare/flux_stt";
import { WorkersAILLMService } from "@pipedog/cloudflare/llm";
import { WorkersAIAuraTTSService } from "@pipedog/cloudflare/tts";

// Inside a Worker or Durable Object
const stt = new WorkersAIFluxSTTService({ ai: env.AI });
const tts = new WorkersAIAuraTTSService({ ai: env.AI, sampleRate: 24000 });
// Anywhere (and for the LLM)
const llm = new WorkersAILLMService({
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: env.CLOUDFLARE_API_TOKEN,
});
```

Share one `WorkersAIClient` between services with the `client` option.

## Runtimes

| Bun | Node.js 22+ | Deno | Cloudflare Workers |
| --- | --- | --- | --- |
| ✅ | ✅ | ✅ | ✅ |

No dependencies beyond pipedog's packages: `fetch` and `WebSocket` (or the binding's socket).
Tested against a local fake of Workers AI over both paths; `test/live_workers_ai.test.ts` runs
against the real API when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set.

## Links

- Docs: [STT](https://polvallverdu.github.io/pipedog/docs/services/stt/cloudflare/),
  [TTS](https://polvallverdu.github.io/pipedog/docs/services/tts/cloudflare/),
  [LLM](https://polvallverdu.github.io/pipedog/docs/services/llm/cloudflare/),
  [voice agent fully on Cloudflare](https://polvallverdu.github.io/pipedog/docs/deployment/cloudflare-workers-ai/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause. See [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
