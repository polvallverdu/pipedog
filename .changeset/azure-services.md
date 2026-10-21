---
"@pipedog/azure": minor
---

Azure services, in the new `@pipedog/azure` package:

- Azure OpenAI: `AzureLLMService` (v1 and dated API surfaces), `AzureRealtimeLLMService` and
  `AzureImageGenServiceREST`, with API keys or Microsoft Entra ID token providers.
- Azure Voice Live: `AzureVoiceLiveLLMService` and its adapter.
- Azure Speech: `AzureSTTService`, `AzureTTSService` (streaming, with word timestamps) and
  `AzureHttpTTSService`, over the Speech service's WebSocket and REST protocols, with no Speech SDK.

All run on Bun, Node, Deno and Cloudflare Workers.
