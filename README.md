# pipecat-ts

An **unofficial** TypeScript port of [Pipecat](https://github.com/pipecat-ai/pipecat), the framework
for real-time voice and multimodal conversational AI, for Bun, Node, Deno and Cloudflare Workers.

The API mirrors Pipecat's (same classes, frames, events and wire protocols, camelCase members), so
Pipecat clients (`@pipecat-ai/client-js`, voice-ui-kit) work against a pipecat-ts bot unchanged.

> Status: early. See [porting/STATUS.md](porting/STATUS.md).

```ts
import { Pipeline } from "@pipecat-ts/core/pipeline/pipeline";
import { PipelineWorker } from "@pipecat-ts/core/pipeline/worker";
import { WorkerRunner } from "@pipecat-ts/core/workers/runner";
```

## Layout

| Path | What |
|---|---|
| `packages/asyncio` | asyncio semantics for JS: tasks, cooperative cancellation, queues, events |
| `packages/core` | frames, processors, pipelines, workers, bus, observers, RTVI, base services/transports |
| `packages/<provider>` | one package per service provider, transport, serializer, audio model |
| `docs/CONVENTIONS.md` | how Python maps to TypeScript |
| `porting/` | manifest of every upstream module/test and its porting status |
| `tools/port/` | dependency graph, work selection, status, license header checks |

## License

BSD 2-Clause, like upstream. Copyright (c) 2024–2026 Daily for the original Pipecat code, and
pipecat-ts contributors for the port. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
