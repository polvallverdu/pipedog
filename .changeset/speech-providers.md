---
"@pipedog/deepgram": minor
"@pipedog/cartesia": minor
"@pipedog/elevenlabs": minor
---

Speech providers: Deepgram, Cartesia and ElevenLabs.

- `@pipedog/deepgram`: `DeepgramSTTService`, `DeepgramTTSService`, `DeepgramHttpTTSService`, and Flux
  (`DeepgramFluxSTTService` with Deepgram's turn detection, `DeepgramFluxTTSService`).
- `@pipedog/cartesia`: `CartesiaSTTService`, `CartesiaTTSService`, `CartesiaHttpTTSService`, and
  `CartesiaTurnsSTTService` with Cartesia's turn detection.
- `@pipedog/elevenlabs`: ElevenLabs STT (batch and realtime) and TTS.

All run on Bun, Node, Deno and Cloudflare Workers.
