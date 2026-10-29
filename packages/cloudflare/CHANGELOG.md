# @pipedog/cloudflare

## 0.11.0

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`34d7530`](https://github.com/polvallverdu/pipedog/commit/34d7530ae607e20db11114b1a5d981bbeb71fa88), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`3fe7566`](https://github.com/polvallverdu/pipedog/commit/3fe756637d4a7364c095d40c877d89ba456fd44e), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0
  - @pipedog/openai@0.11.0
  - @pipedog/deepgram@0.11.0

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
