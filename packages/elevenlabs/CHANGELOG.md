# @pipedog/elevenlabs

## 0.7.0

### Minor Changes

- [#59](https://github.com/polvallverdu/pipedog/pull/59) [`48371fa`](https://github.com/polvallverdu/pipedog/commit/48371fa8f9c606699d5c3e4667ecbf8ccfb95114) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Four text-to-speech ports, all on Bun, Node, Deno and Cloudflare Workers.
  
  - `@pipedog/rime` (new): `RimeTTSService` (JSON WebSocket with word timestamps), `RimeHttpTTSService` and `RimeV1TTSService` (WebSocket v1, protobuf in binary or JSON envelopes, using Rime's own `@rimelabs/api`). The deprecated `RimeNonJsonTTSService` is not ported.
  - `@pipedog/fish` (new): `FishAudioTTSService`, Fish Audio's MessagePack WebSocket API, with `@msgpack/msgpack` in place of `ormsgpack`.
  - `@pipedog/hume` (new): `HumeTTSService`, calling Hume's `tts/stream/json` endpoint with `fetch` instead of the Hume SDK, with word timestamps.
  - `@pipedog/elevenlabs`: `ElevenLabsDialogueTTSService`, ElevenLabs Text to Dialogue (Eleven v3 and v4 models).
  
  Docs: new Rime, Fish Audio and Hume pages, and a Text to Dialogue section on the ElevenLabs page, each with a runtime matrix.

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0

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
