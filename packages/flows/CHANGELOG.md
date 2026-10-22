# @pipedog/flows

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#47](https://github.com/polvallverdu/pipedog/pull/47) [`61b0e2d`](https://github.com/polvallverdu/pipedog/commit/61b0e2db3ad3d095c31ed12846fa7ec33f821909) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add `@pipedog/flows`, a port of Pipecat Flows: nodes, direct functions, actions, context strategies, YAML/JSON flow configs (`FlowConfig`, `Flow`) and `FlowManager`, with docs and end-to-end tests on OpenAI, Anthropic and Google. `@pipedog/google` now sends tools to Gemini in the form the JS SDK reads (`functionDeclarations`); before, function calling offered the model no tools.

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
