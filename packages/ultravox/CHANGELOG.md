# @pipedog/ultravox

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

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

### Minor Changes

- [#32](https://github.com/polvallverdu/pipedog/pull/32) [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Speech-to-speech providers: Inworld and Ultravox.
  
  - `@pipedog/inworld`: `InworldRealtimeLLMService` (Inworld's Realtime API, with its events and
    adapter), and `InworldTTSService` (WebSocket) and `InworldHttpTTSService`.
  - `@pipedog/ultravox`: `UltravoxRealtimeLLMService`, with agent, one-shot and join-URL calls.
  - `@pipedog/core`: `ServiceSettings.fromMapping()` builds the subclass it is called on again, so
    `TTSSettings.fromMapping({ voice_id: "alice" })` sets `voice` instead of putting every key in
    `extra`.
  
  Both run on Bun, Node, Deno and Cloudflare Workers.

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0
