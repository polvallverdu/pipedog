# @pipedog/soniox

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

- [#56](https://github.com/polvallverdu/pipedog/pull/56) [`28c42f5`](https://github.com/polvallverdu/pipedog/commit/28c42f5bee274f887c154f9c298bed84352865dc) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add the popular speech-to-text providers, each in its own package and running on Bun, Node, Deno
  and Cloudflare Workers (raw `fetch` and `WebSocket`, no SDKs):
  
  - `@pipedog/assemblyai`: Universal-Streaming v3 STT and the sync HTTP STT.
  - `@pipedog/speechmatics`: STT (Agent STT protocol) and TTS.
  - `@pipedog/gladia`: realtime STT.
  - `@pipedog/soniox`: STT and TTS.

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
