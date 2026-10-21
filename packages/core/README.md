# @pipedog/core

The core of pipedog, an unofficial TypeScript port of [Pipecat](https://github.com/pipecat-ai/pipecat):
frames, frame processors, pipelines, pipeline workers and the worker runner, the bus, observers,
RTVI, user turn strategies, utilities, and the base classes for services, transports and
serializers. Provider services, transports and audio models live in their own `@pipedog/*` packages
and build on this one.

It ports Pipecat's core import closure (`pipecat.frames`, `pipecat.processors`, `pipecat.pipeline`,
`pipecat.workers`, `pipecat.observers`, `pipecat.turns`, `pipecat.utils` and the base services and
transports). Every module keeps its upstream path, so `pipecat.pipeline.worker` is
`@pipedog/core/pipeline/worker`. Members are camelCase; class names, event names and wire formats
are unchanged.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio
```

`@opentelemetry/api` is an optional peer, used only when tracing is on (see
[`@pipedog/tracing`](https://www.npmjs.com/package/@pipedog/tracing)).

## Usage

```ts
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { WorkerRunner } from "@pipedog/core/workers/runner";

const pipeline = new Pipeline([/* transport.input(), stt, llm, tts, transport.output() */]);
const worker = new PipelineWorker(pipeline);
const runner = new WorkerRunner();
await runner.addWorkers(worker);
await runner.run();
```

The [quickstart](https://polvallverdu.github.io/pipedog/docs/quickstart/) builds a complete
pipeline with custom frame processors and no API keys.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers (with `nodejs_compat`). Core imports no `node:*`
module, uses no `Buffer` and no runtime-specific APIs.

## Links

- Docs: [frames](https://polvallverdu.github.io/pipedog/docs/concepts/frames/),
  [pipelines and workers](https://polvallverdu.github.io/pipedog/docs/concepts/pipelines-and-workers/),
  [coming from Pipecat](https://polvallverdu.github.io/pipedog/docs/coming-from-pipecat/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
