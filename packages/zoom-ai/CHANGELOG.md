# @pipedog/zoom-ai

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
