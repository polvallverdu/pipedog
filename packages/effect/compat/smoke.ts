// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: a pipeline with an Effect processor,
// driven from Effect end to end, then an interrupted run that must cancel the
// pipeline and leave no tasks behind, and a pipeline-side cancellation that
// must interrupt the processor's Effect.

import { EndFrame, type Frame, TextFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { FrameDirection, type FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeProcessor, runPipeline, startPipeline } from "../src/index.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`effect smoke: ${message}`);
}

const worker = (processors: FrameProcessor[], taskManager: TaskManager | null = null) =>
  new PipelineWorker(new Pipeline(processors), {
    cancelOnIdleTimeout: false,
    idleTimeoutSecs: null,
    taskManager,
  });

const isDownText = (frame: Frame, direction: FrameDirection): frame is TextFrame =>
  frame instanceof TextFrame && direction === FrameDirection.DOWNSTREAM;

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");

  // End to end.
  const texts = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const upper = yield* makeProcessor((frame, direction, ctx) =>
          isDownText(frame, direction)
            ? ctx.push(new TextFrame({ text: frame.text.toUpperCase() }))
            : ctx.push(frame, direction),
        );
        const pipeline = yield* startPipeline(worker([upper]));
        const out = yield* pipeline.frames(TextFrame);
        yield* pipeline.queueFrames(
          Stream.fromIterable<Frame>([new TextFrame({ text: "hi" }), new EndFrame()]),
        );
        yield* pipeline.join;
        return (yield* Stream.runCollect(out)).map((f) => f.text);
      }),
    ),
  );
  check(texts.join() === "HI", `texts: ${texts}`);

  // Effect interruption cancels the pipeline, without leaking tasks.
  const taskManager = new TaskManager();
  const interrupted = worker([], taskManager);
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runPipeline(interrupted, { runner: { taskManager, checkDanglingTasks: false } }),
      );
      yield* Effect.sleep("20 millis");
      yield* Fiber.interrupt(fiber);
    }),
  );
  check(interrupted.hasFinished(), "interrupted pipeline still running");
  const left = taskManager.currentTasks().map((t) => t.getName());
  check(left.length === 0, `tasks left: ${left}`);

  // Pipeline cancellation interrupts the processor's Effect and `join`.
  let processorInterrupted = false;
  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const blocking = yield* makeProcessor((frame, direction, ctx) =>
          isDownText(frame, direction)
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    processorInterrupted = true;
                  }),
                ),
              )
            : ctx.push(frame, direction),
        );
        const pipeline = yield* startPipeline(worker([blocking]));
        yield* pipeline.queueFrame(new TextFrame({ text: "block" }));
        yield* Deferred.await(started);
        yield* pipeline.cancel();
        return yield* Effect.exit(pipeline.join);
      }),
    ),
  );
  check(processorInterrupted, "processor Effect not interrupted");
  check(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "join not interrupted");
}
