# @pipedog/bland

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

- [#60](https://github.com/polvallverdu/pipedog/pull/60) [`989ce3c`](https://github.com/polvallverdu/pipedog/commit/989ce3c051932374b9c27c51eac1fd48dd19caa0) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Seven more text-to-speech providers, each in its own package.
  
  - `@pipedog/neuphonic` (new): `NeuphonicTTSService` over WebSocket and `NeuphonicHttpTTSService` over server-sent events.
  - `@pipedog/speechify` (new): `SpeechifyHttpTTSService`, streaming audio and word timestamps over server-sent events.
  - `@pipedog/minimax` (new): `MiniMaxHttpTTSService`, MiniMax's T2A streaming API.
  - `@pipedog/resembleai` (new): `ResembleAITTSService` over WebSocket, with word timestamps.
  - `@pipedog/camb` (new): `CambTTSService` for the MARS models. It calls Camb's streaming endpoint with `fetch`, in place of the Python SDK.
  - `@pipedog/asyncai` (new): `AsyncAITTSService` over WebSocket and `AsyncAIHttpTTSService` over HTTP.
  - `@pipedog/bland` (new): `BlandTTSService` over Bland's realtime WebSocket (LLM tokens streamed, barge-in as `cancel`) and `BlandHttpTTSService`.
  
  All of them use `fetch` and core's `websocketConnect`, so they run on Bun, Node, Deno and Cloudflare Workers. They were tested against local fake servers, not the real services. The upstream tests are ported (Speechify, MiniMax, Resemble AI, Async, Bland), and Neuphonic and Camb, which have none upstream, have their own.

### Patch Changes

- [#64](https://github.com/polvallverdu/pipedog/pull/64) [`4b9b35c`](https://github.com/polvallverdu/pipedog/commit/4b9b35c98b95ef9b99f324d5d8a832101996666e) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add the missing package READMEs, so the install and usage notes show on npm.
- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
