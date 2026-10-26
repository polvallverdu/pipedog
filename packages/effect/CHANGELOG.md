# @pipedog/effect

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Minor Changes

- [#73](https://github.com/polvallverdu/pipedog/pull/73) [`9d62521`](https://github.com/polvallverdu/pipedog/commit/9d62521d8c51d5a1c761aa7b5400ef4e87601136) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New package `@pipedog/effect`, an adapter for [Effect](https://effect.website) 4: `startPipeline` runs a `PipelineWorker` as a scoped Effect (closing the scope cancels the pipeline and waits for it, a pipeline cancelled from its side interrupts `join`, failures become a typed `PipelineError`), its handle streams the frames that reach the end of the pipeline and queues frames from a `Stream`, `runPipeline` runs one to completion, and `makeProcessor` builds a frame processor from an Effect function whose services come from Layers, with cancellation propagating both ways.

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/asyncio@0.9.0
