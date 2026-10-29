# @pipedog/audio-ten-vad

## 0.11.0

### Minor Changes

- [#106](https://github.com/polvallverdu/pipedog/pull/106) [`68f8ede`](https://github.com/polvallverdu/pipedog/commit/68f8ede8f89365bc4c57fdb42c01fa2a5f1d3ba9) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New package `@pipedog/audio-ten-vad` (pipedog only): `TenVADAnalyzer`, a VAD analyzer backed by
  [TEN VAD](https://github.com/TEN-framework/ten-vad), as an opt-in alternative to Silero. It drives
  TEN VAD's prebuilt WebAssembly build through TEN's documented interface; `loadTenVadModule()`
  loads it from the `.wasm` bytes, a precompiled `WebAssembly.Module` (Cloudflare Workers) or TEN's
  own loader. pipedog ships none of TEN's code, WebAssembly or model: you obtain `ten_vad.js` and
  `ten_vad.wasm` from TEN, and TEN's license (Apache-2.0 with additional conditions) applies to your
  use of them. 16 kHz only, 160- or 256-sample frames.

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0
