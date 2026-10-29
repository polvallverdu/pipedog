# @pipedog/transport-local

## 0.11.0

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

- [#52](https://github.com/polvallverdu/pipedog/pull/52) [`84f2ad1`](https://github.com/polvallverdu/pipedog/commit/84f2ad14d46caf4214cd9a5ddd9d8d3038c39e9e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Five more upstream modules.
  
  - `@pipedog/audio-smart-turn`: `HttpSmartTurnAnalyzer`, Smart Turn over HTTP. It needs only `fetch`, so it runs on every runtime, Workers included, and takes a `fetch` option where upstream takes an aiohttp session.
  - `@pipedog/audio-rnnoise-filter` (new): `RNNoiseFilter`. RNNoise 0.2 runs as WebAssembly (the module `@jitsi/rnnoise-wasm` builds, 1.4 MB, shipped in the package) instead of the native `pyrnnoise`, so it works on Bun, Node, Deno and Cloudflare Workers.
  - `@pipedog/audio-soundfile-mixer` (new): `SoundfileMixer`. WAV only, parsed in pure TypeScript instead of libsndfile. Sounds can be bytes, a URL or a path (a path needs a filesystem).
  - `@pipedog/transport-whatsapp` (new): `WhatsAppClient` and `WhatsAppApi` for WhatsApp Business calling: Meta's webhooks, HMAC signature checks, `pre_accept`, `accept`, `reject` and `terminate`, on SmallWebRTC. Whole calls run on Bun, Node and Deno. On Workers only the webhook verification, signature check and API calls work.
  - `@pipedog/transport-local` (new): `LocalAudioTransport`, the machine's microphone and speakers through `sox` or `ffmpeg` child processes, with no native addon. Bun, Node and Deno only. It throws a clear error when neither tool is installed.
  
  Docs: a new Audio filters & mixers section, the HTTP Smart Turn section of the turn detection page, WhatsApp and Local audio transport pages, and a per-package runtime matrix that also says what each runtime needs. Not ported, on purpose: `local_smart_turn_v2`, `local_coreml_smart_turn` (Smart Turn v3 replaces them) and the Tkinter transport.

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
