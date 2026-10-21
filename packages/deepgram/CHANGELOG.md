# @pipedog/deepgram

## 0.4.0

### Minor Changes

- [#19](https://github.com/polvallverdu/pipedog/pull/19) [`f24da7d`](https://github.com/polvallverdu/pipedog/commit/f24da7d0426ff2237579f8b7a4374271d474c45d) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Speech providers: Deepgram, Cartesia and ElevenLabs.
  
  - `@pipedog/deepgram`: `DeepgramSTTService`, `DeepgramTTSService`, `DeepgramHttpTTSService`, and Flux
    (`DeepgramFluxSTTService` with Deepgram's turn detection, `DeepgramFluxTTSService`).
  - `@pipedog/cartesia`: `CartesiaSTTService`, `CartesiaTTSService`, `CartesiaHttpTTSService`, and
    `CartesiaTurnsSTTService` with Cartesia's turn detection.
  - `@pipedog/elevenlabs`: ElevenLabs STT (batch and realtime) and TTS.
  
  All run on Bun, Node, Deno and Cloudflare Workers.

### Patch Changes

- Updated dependencies [[`b88231a`](https://github.com/polvallverdu/pipedog/commit/b88231af79d984e191b54c30965fa062a60ec8c3)]:
  - @pipedog/core@0.4.0
  - @pipedog/asyncio@0.4.0
