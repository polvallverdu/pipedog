# @pipedog/cloudflare

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/deepgram@0.10.0
  - @pipedog/openai@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Minor Changes

- [#78](https://github.com/polvallverdu/pipedog/pull/78) [`5b7f383`](https://github.com/polvallverdu/pipedog/commit/5b7f3838f90e677c7ea23dcbdd52605bd3084c19) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New package `@pipedog/cloudflare`: Cloudflare Workers AI services, over the Worker's `AI` binding or the REST API. Deepgram Flux (`WorkersAIFluxSTTService`, with turn detection), Nova-3 (`WorkersAINova3STTService`) and Whisper (`WorkersAIWhisperSTTService`) speech-to-text; Aura (`WorkersAIAuraTTSService` over a WebSocket, `WorkersAIAuraHttpTTSService`) and MeloTTS (`WorkersAIMeloTTSService`) text-to-speech; `WorkersAILLMService` on the OpenAI-compatible endpoint; and `WorkersAISmartTurnAnalyzer` for Smart Turn v2. `pipedog init` offers the Flux, Whisper, Aura and LLM services.

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/deepgram@0.9.0
  - @pipedog/openai@0.9.0
  - @pipedog/asyncio@0.9.0
