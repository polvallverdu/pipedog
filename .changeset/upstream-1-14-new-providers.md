---
"@pipedog/nvidia": minor
"@pipedog/zoom-ai": minor
"@pipedog/tone": minor
"@pipedog/assemblyai": minor
"@pipedog/core": minor
"@pipedog/cli": minor
---

New providers from pipecat main after 1.14:

- `@pipedog/nvidia` (new): `NvidiaLLMService` (NVIDIA NIM, OpenAI-compatible, with reasoning
  content and `<think>` handling) and `NvidiaOmniLLMService` (Nemotron Omni: audio understanding
  and the user's turn in one request, `NvidiaOmniLLMAdapter`, `runMultimodalInference()`,
  pipecat-ai/pipecat#6085). Riva STT/TTS are not ported yet.
- `@pipedog/zoom-ai` (new): `ZoomAISTTService`, Zoom's Scribe streaming STT (#6280).
- `@pipedog/assemblyai`: `AssemblyAITTSService`, streaming TTS with per-word timings (#6322).
- Pipecat Tone for expressive conversation (alpha): the `PipecatToneReader` and
  `PipecatToneTagger` processors in `@pipedog/core/processors/tone`, with their ONNX models in the
  new `@pipedog/tone` (on `@pipedog/onnx`; #6319, #6385, #6407).
- The CLI offers Zoom AI STT, AssemblyAI TTS and the NVIDIA LLM.
