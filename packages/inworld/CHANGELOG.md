# @pipedog/inworld

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
