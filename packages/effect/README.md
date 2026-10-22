# @pipedog/effect

Use pipedog from [Effect](https://effect.website). Run a `PipelineWorker` as a scoped resource,
stream the frames that reach the end of the pipeline, feed it frames from a `Stream`, and write
frame processors as Effect functions whose services come from Layers. pipedog-only: Pipecat has no
counterpart.

```sh
bun add @pipedog/effect effect
```

`effect` (version 4) is a peer dependency.

```ts
import { EndFrame, TextFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { makeProcessor, startPipeline } from "@pipedog/effect";
import { Effect, Stream } from "effect";

const program = Effect.gen(function* () {
  const upper = yield* makeProcessor((frame, direction, ctx) =>
    frame instanceof TextFrame && direction === FrameDirection.DOWNSTREAM
      ? ctx.push(new TextFrame({ text: frame.text.toUpperCase() }))
      : ctx.push(frame, direction),
  );
  const pipeline = yield* startPipeline(new PipelineWorker(new Pipeline([upper])));
  const texts = yield* pipeline.frames(TextFrame);
  yield* pipeline.queueFrames([new TextFrame({ text: "hello" }), new EndFrame()]);
  yield* pipeline.join;
  return yield* Stream.runCollect(texts); // [TextFrame("HELLO")]
});

await Effect.runPromise(Effect.scoped(program));
```

| Export | |
|---|---|
| `startPipeline(worker, options?)` | Runs the worker for the lifetime of the current `Scope`; returns a handle with `join`, `queueFrame`, `queueFrames` (iterable or `Stream`), `frames(...types)`, `stopWhenDone`, `cancel`. |
| `runPipeline(worker, options?)` | `startPipeline` and `join` in a scope of their own. |
| `makeProcessor(fn, options?)` | A `FrameProcessor` from `(frame, direction, ctx) => Effect`, with the services it needs captured from the context. |
| `PipelineError` | The tagged error a failed run fails with. |

Cancellation goes both ways. Interrupting the Effect (or closing the scope) cancels the pipeline and
waits until it has finished, with no task left behind. A pipeline cancelled from its side interrupts
`join`, and a processor's running Effect is interrupted when the pipeline cancels its task (a
cancel, or an `InterruptionFrame`).

## Runtimes

| | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `startPipeline`, `runPipeline`, `makeProcessor` | ✅ | ✅ | ✅ | ✅ |

Verified with Effect 4.0.2: a pipeline with an Effect processor run end to end, an interrupted run
that must leave no tasks behind, and a cancelled pipeline that must interrupt the processor's Effect.

See [Effect](https://polvallverdu.github.io/pipedog/docs/guides/effect/) for the full guide.

## License

BSD 2-Clause.
