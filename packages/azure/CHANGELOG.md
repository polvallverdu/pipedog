# @pipedog/azure

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1
  - @pipedog/openai@0.6.1

## 0.6.0

### Minor Changes

- [#31](https://github.com/polvallverdu/pipedog/pull/31) [`1c1e3a2`](https://github.com/polvallverdu/pipedog/commit/1c1e3a26cb9e2baa1e63c67fbb8a5fe03c4d2570) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Azure services, in the new `@pipedog/azure` package:
  
  - Azure OpenAI: `AzureLLMService` (v1 and dated API surfaces), `AzureRealtimeLLMService` and
    `AzureImageGenServiceREST`, with API keys or Microsoft Entra ID token providers.
  - Azure Voice Live: `AzureVoiceLiveLLMService` and its adapter.
  - Azure Speech: `AzureSTTService`, `AzureTTSService` (streaming, with word timestamps) and
    `AzureHttpTTSService`, over the Speech service's WebSocket and REST protocols, with no Speech SDK.
  
  All run on Bun, Node, Deno and Cloudflare Workers.

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0
  - @pipedog/openai@0.6.0
