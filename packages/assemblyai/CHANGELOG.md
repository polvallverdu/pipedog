# @pipedog/assemblyai

## 0.11.0

### Minor Changes

- [#105](https://github.com/polvallverdu/pipedog/pull/105) [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New providers from pipecat main after 1.14:
  
  - `@pipedog/nvidia` (new): `NvidiaLLMService` (NVIDIA NIM, OpenAI-compatible, with reasoning
    content and `<think>` handling) and `NvidiaOmniLLMService` (Nemotron Omni: audio understanding
    and the user's turn in one request, `NvidiaOmniLLMAdapter`, `runMultimodalInference()`,
    pipecat-ai/pipecat#6085). Riva STT/TTS are not ported yet.
  - `@pipedog/zoom-ai` (new): `ZoomAISTTService`, Zoom's Scribe streaming STT ([#6280](https://github.com/polvallverdu/pipedog/issues/6280)).
  - `@pipedog/assemblyai`: `AssemblyAITTSService`, streaming TTS with per-word timings ([#6322](https://github.com/polvallverdu/pipedog/issues/6322)).
  - Pipecat Tone for expressive conversation (alpha): the `PipecatToneReader` and
    `PipecatToneTagger` processors in `@pipedog/core/processors/tone`, with their ONNX models in the
    new `@pipedog/tone` (on `@pipedog/onnx`; [#6319](https://github.com/polvallverdu/pipedog/issues/6319), [#6385](https://github.com/polvallverdu/pipedog/issues/6385), [#6407](https://github.com/polvallverdu/pipedog/issues/6407)).
  - The CLI offers Zoom AI STT, AssemblyAI TTS and the NVIDIA LLM.

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#56](https://github.com/polvallverdu/pipedog/pull/56) [`28c42f5`](https://github.com/polvallverdu/pipedog/commit/28c42f5bee274f887c154f9c298bed84352865dc) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add the popular speech-to-text providers, each in its own package and running on Bun, Node, Deno
  and Cloudflare Workers (raw `fetch` and `WebSocket`, no SDKs):
  
  - `@pipedog/assemblyai`: Universal-Streaming v3 STT and the sync HTTP STT.
  - `@pipedog/speechmatics`: STT (Agent STT protocol) and TTS.
  - `@pipedog/gladia`: realtime STT.
  - `@pipedog/soniox`: STT and TTS.

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
