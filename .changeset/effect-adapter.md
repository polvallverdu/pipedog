---
"@pipedog/effect": minor
---

New package `@pipedog/effect`, an adapter for [Effect](https://effect.website) 4: `startPipeline` runs a `PipelineWorker` as a scoped Effect (closing the scope cancels the pipeline and waits for it, a pipeline cancelled from its side interrupts `join`, failures become a typed `PipelineError`), its handle streams the frames that reach the end of the pipeline and queues frames from a `Stream`, `runPipeline` runs one to completion, and `makeProcessor` builds a frame processor from an Effect function whose services come from Layers, with cancellation propagating both ways.
