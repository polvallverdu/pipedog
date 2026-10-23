# @pipedog/rime

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
