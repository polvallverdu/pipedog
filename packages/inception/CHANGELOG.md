# @pipedog/inception

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/openai@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#58](https://github.com/polvallverdu/pipedog/pull/58) [`cc21620`](https://github.com/polvallverdu/pipedog/commit/cc21620aa0d9d6a0f4dab793197cf24ced3eecc1) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add `@pipedog/sarvam` (SarvamLLMService, SarvamSTTService, SarvamRealtimeSTTService, SarvamTTSService, SarvamHttpTTSService), `@pipedog/smallest` (SmallestSTTService, SmallestTTSService), `@pipedog/gradium` (GradiumSTTService, GradiumTTSService), `@pipedog/meta` (MetaSTTService) and `@pipedog/inception` (InceptionLLMService), with docs. All run on Bun, Node, Deno and Cloudflare Workers: HTTP goes through `fetch` and WebSockets through the core `websocketConnect`, with no provider SDKs.

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/openai@0.7.0
  - @pipedog/asyncio@0.7.0
