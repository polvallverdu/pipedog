# @pipedog/cartesia

## 0.5.0

### Patch Changes

- [#20](https://github.com/polvallverdu/pipedog/pull/20) [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Package READMEs on npm. `@pipedog/core`, `@pipedog/asyncio`, `@pipedog/openai`,
  `@pipedog/anthropic`, `@pipedog/deepgram`, `@pipedog/cartesia`, `@pipedog/elevenlabs`,
  `@pipedog/tracing` and `@pipedog/whisper` now ship a README with install steps, a usage snippet,
  runtimes and links to the docs. Every package gains npm `keywords`, and the `@pipedog/elevenlabs`
  description no longer lists Text-to-Dialogue, which is not ported yet.
- Updated dependencies [[`70dce6f`](https://github.com/polvallverdu/pipedog/commit/70dce6fcf5ffefa49ef2c21f87bac6377f0d5a09), [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301)]:
  - @pipedog/core@0.5.0
  - @pipedog/asyncio@0.5.0

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
