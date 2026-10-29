# @pipedog/fish

## 0.11.0

### Minor Changes

- [#103](https://github.com/polvallverdu/pipedog/pull/103) [`3fe7566`](https://github.com/polvallverdu/pipedog/commit/3fe756637d4a7364c095d40c877d89ba456fd44e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Speech providers brought up to pipecat main after 1.14:
  
  - Expression adapters for expressive conversation (alpha): `CartesiaExpressionAdapter`
    (`@pipedog/cartesia/cartesia_adapter`, `CartesiaEmotion` now lives there),
    `ElevenLabsAudioTagExpressionAdapter`, Fish Audio S2 and MiniMax adapters. With
    `enableExpressiveConversation`, the TTS services perform the tags the LLM writes.
  - Cartesia: `accent` setting ([#6429](https://github.com/polvallverdu/pipedog/issues/6429)), regional locales and CJK punctuation tokens; the turns STT
    reconnects from its receive loop and ends a turn cut short by a dropped connection with the
    transcript so far ([#6242](https://github.com/polvallverdu/pipedog/issues/6242)).
  - ElevenLabs: audio tags reported as words, and the word clock advances on wordless alignment
    ([#6297](https://github.com/polvallverdu/pipedog/issues/6297)).
  - Deepgram: the TTS and Flux services report the `dg-error` reason of a refused connection, and
    Flux STT waits for `Connected` through the core `_receiveUntilConfirmed`.
  - Inworld TTS reconnects from its receive loop ([#6300](https://github.com/polvallverdu/pipedog/issues/6300)); Sarvam STT reconnects ([#6342](https://github.com/polvallverdu/pipedog/issues/6342)).
  - Smallest: `dateFormat` and the `"redact"` content filter ([#6431](https://github.com/polvallverdu/pipedog/issues/6431)). Speechify: `pronunciations`
    ([#6436](https://github.com/polvallverdu/pipedog/issues/6436)) and `simba-3.5` as the default model. Google Vertex defaults to `gemini-3.8-flash`.

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
