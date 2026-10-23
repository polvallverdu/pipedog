// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CancelWorkerFrame,
  EndFrame,
  type Frame,
  InterruptionFrame,
  TextFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker, ProcessorUnusablePolicy } from "@pipedog/core/pipeline/worker";
import { FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  makeProcessor,
  PipelineError,
  type ProcessFrameContext,
  runPipeline,
  startPipeline,
} from "../src/index.ts";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeAll(() => {
  logger.setLevel("CRITICAL");
  process.on("unhandledRejection", onUnhandled);
});

afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

/** Forward a frame unchanged. */
const forward = (frame: Frame, direction: FrameDirection, ctx: ProcessFrameContext) =>
  ctx.push(frame, direction);

const isDownText = (frame: Frame, direction: FrameDirection): frame is TextFrame =>
  frame instanceof TextFrame && direction === FrameDirection.DOWNSTREAM;

function makeWorker(processors: FrameProcessor[], options: { taskManager?: TaskManager } = {}) {
  return new PipelineWorker(new Pipeline(processors), {
    cancelOnIdleTimeout: false,
    idleTimeoutSecs: null,
    taskManager: options.taskManager ?? null,
  });
}

const texts = (frames: readonly Frame[]) =>
  frames.filter((f): f is TextFrame => f instanceof TextFrame).map((f) => f.text);

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

describe("end to end", () => {
  test("a pipeline driven from Effect, with an Effect processor", async () => {
    const program = Effect.gen(function* () {
      const upper = yield* makeProcessor((frame, direction, ctx) =>
        isDownText(frame, direction)
          ? ctx.push(new TextFrame({ text: frame.text.toUpperCase() }))
          : ctx.push(frame, direction),
      );
      const pipeline = yield* startPipeline(makeWorker([upper]));
      const out = yield* pipeline.frames(TextFrame);
      const collected = yield* Effect.forkChild(Stream.runCollect(out));
      yield* pipeline.queueFrames(
        Stream.fromIterable<Frame>([
          new TextFrame({ text: "hello" }),
          new TextFrame({ text: "effect" }),
          new EndFrame(),
        ]),
      );
      yield* pipeline.join;
      return texts(yield* Fiber.join(collected));
    });
    const exit = await run(Effect.scoped(program));
    expect(exit).toEqual(Exit.succeed(["HELLO", "EFFECT"]));
  });

  test("processor services come from Layers", async () => {
    class Translator extends Context.Service<
      Translator,
      { translate(text: string): Effect.Effect<string> }
    >()("Translator") {}

    const program = Effect.gen(function* () {
      const translator = yield* Translator;
      const processor = yield* makeProcessor((frame, direction, ctx) =>
        isDownText(frame, direction)
          ? Effect.flatMap(translator.translate(frame.text), (text) =>
              ctx.push(new TextFrame({ text })),
            )
          : ctx.push(frame, direction),
      );
      const pipeline = yield* startPipeline(makeWorker([processor]));
      const out = yield* pipeline.frames(TextFrame);
      yield* pipeline.queueFrames([new TextFrame({ text: "hola" }), new EndFrame()]);
      yield* pipeline.join;
      return texts(yield* Stream.runCollect(out));
    });

    const TestTranslator = Layer.succeed(Translator, {
      translate: (text) => Effect.succeed(text === "hola" ? "hello" : text),
    });
    const exit = await run(Effect.scoped(program).pipe(Effect.provide(TestTranslator)));
    expect(exit).toEqual(Exit.succeed(["hello"]));
  });

  test("an async Effect processor keeps frame order", async () => {
    const program = Effect.gen(function* () {
      const slow = yield* makeProcessor((frame, direction, ctx) =>
        isDownText(frame, direction)
          ? Effect.andThen(Effect.sleep(`${5 - frame.text.length} millis`), ctx.push(frame))
          : ctx.push(frame, direction),
      );
      const pipeline = yield* startPipeline(makeWorker([slow]));
      const out = yield* pipeline.frames(TextFrame);
      yield* pipeline.queueFrames(
        ["a", "bb", "ccc", "dddd"].map((text) => new TextFrame({ text })),
      );
      yield* pipeline.stopWhenDone;
      yield* pipeline.join;
      return texts(yield* Stream.runCollect(out));
    });
    const exit = await run(Effect.scoped(program));
    expect(exit).toEqual(Exit.succeed(["a", "bb", "ccc", "dddd"]));
  });

  test("the frame stream ends when the pipeline ends", async () => {
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const pipeline = yield* startPipeline(makeWorker([]));
          const out = yield* pipeline.frames();
          yield* pipeline.queueFrame(new EndFrame());
          return (yield* Stream.runCollect(out)).map((f) => f.constructor.name);
        }),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.at(-1)).toBe("EndFrame");
  });
});

describe("Effect interruption cancels the pipeline", () => {
  test("interrupting runPipeline cancels the worker and leaks no tasks", async () => {
    const taskManager = new TaskManager();
    const worker = makeWorker([], { taskManager });
    const exit = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          runPipeline(worker, { runner: { taskManager, checkDanglingTasks: false } }),
        );
        yield* Effect.sleep("50 millis");
        expect(worker.hasFinished()).toBe(false);
        return yield* Fiber.interrupt(fiber);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(worker.hasFinished()).toBe(true);
    expect(taskManager.currentTasks().map((t) => t.getName())).toEqual([]);
  });

  test("interrupting the scope interrupts a running processor Effect first", async () => {
    const events: string[] = [];
    const exit = await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const blocking = yield* makeProcessor((frame, direction, ctx) =>
          isDownText(frame, direction)
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Effect.sync(() => events.push("processor interrupted"))),
              )
            : ctx.push(frame, direction),
        );
        const worker = makeWorker([blocking]);
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              const pipeline = yield* startPipeline(worker);
              yield* pipeline.queueFrame(new TextFrame({ text: "block" }));
              yield* pipeline.join;
            }),
          ),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        events.push(`worker finished: ${worker.hasFinished()}`);
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events).toEqual(["processor interrupted", "worker finished: true"]);
  });

  test("Effect.timeout around runPipeline cancels it", async () => {
    const worker = makeWorker([]);
    const exit = await run(runPipeline(worker).pipe(Effect.timeoutOption("30 millis")));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(worker.hasFinished()).toBe(true);
  });
});

describe("pipeline cancellation interrupts the Effect side", () => {
  test("cancel() interrupts join", async () => {
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const pipeline = yield* startPipeline(makeWorker([forwarder()]));
          yield* pipeline.cancel("done here");
          yield* pipeline.join;
        }),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  });

  test("a CancelWorkerFrame from a processor interrupts runPipeline", async () => {
    const quitter = new (class extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof TextFrame) {
          await this.pushFrame(new CancelWorkerFrame(), FrameDirection.UPSTREAM);
        } else {
          await this.pushFrame(frame, direction);
        }
      }
    })();
    const worker = makeWorker([quitter]);
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const pipeline = yield* startPipeline(worker);
          yield* pipeline.queueFrame(new TextFrame({ text: "quit" }));
          yield* pipeline.join;
        }),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(worker.hasFinished()).toBe(true);
  });

  test("cancelling the pipeline interrupts a running processor Effect", async () => {
    const events: string[] = [];
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const blocking = yield* makeProcessor((frame, direction, ctx) =>
            isDownText(frame, direction)
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Effect.sync(() => events.push("interrupted"))),
                )
              : ctx.push(frame, direction),
          );
          const pipeline = yield* startPipeline(makeWorker([blocking]));
          yield* pipeline.queueFrame(new TextFrame({ text: "block" }));
          yield* Deferred.await(started);
          yield* pipeline.cancel();
          return yield* Effect.exit(pipeline.join);
        }),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(Exit.isFailure(exit.value) && Cause.hasInterruptsOnly(exit.value.cause)).toBe(true);
    }
    expect(events).toEqual(["interrupted"]);
  });
});

describe("interruptions", () => {
  test("an InterruptionFrame interrupts the processor Effect and the pipeline goes on", async () => {
    const events: string[] = [];
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const processor = yield* makeProcessor((frame, direction, ctx) =>
            isDownText(frame, direction) && frame.text === "block"
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Effect.sync(() => events.push("interrupted"))),
                )
              : ctx.push(frame, direction),
          );
          const pipeline = yield* startPipeline(makeWorker([processor]));
          const out = yield* pipeline.frames(TextFrame);
          yield* pipeline.queueFrame(new TextFrame({ text: "block" }));
          yield* Deferred.await(started);
          yield* pipeline.queueFrames([
            new InterruptionFrame(),
            new TextFrame({ text: "after" }),
            new EndFrame(),
          ]);
          yield* pipeline.join;
          return texts(yield* Stream.runCollect(out));
        }),
      ),
    );
    expect(exit).toEqual(Exit.succeed(["after"]));
    expect(events).toEqual(["interrupted"]);
  });
});

describe("errors", () => {
  class Boom extends Error {}

  const failing = () =>
    makeProcessor((frame, direction, ctx) =>
      isDownText(frame, direction) ? Effect.fail(new Boom("boom")) : ctx.push(frame, direction),
    );

  test("a failing processor Effect pushes an ErrorFrame and the pipeline goes on", async () => {
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const pipeline = yield* startPipeline(makeWorker([yield* failing()]));
          const out = yield* pipeline.frames(TextFrame);
          yield* pipeline.queueFrames([new TextFrame({ text: "x" }), new EndFrame()]);
          yield* pipeline.join;
          return texts(yield* Stream.runCollect(out));
        }),
      ),
    );
    expect(exit).toEqual(Exit.succeed([]));
  });

  test("failOnError fails runPipeline with a PipelineError", async () => {
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const pipeline = yield* startPipeline(makeWorker([yield* failing()]), {
            failOnError: true,
          });
          yield* pipeline.queueFrame(new TextFrame({ text: "x" }));
          yield* pipeline.join;
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).frame?.exception).toBeInstanceOf(Boom);
    }
  });

  test("an unusable processor that cancels the pipeline fails it", async () => {
    const permanent = new (class extends FrameProcessor {
      override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
        await super.processFrame(frame, direction);
        if (frame instanceof TextFrame) {
          await this.pushError("gone", { forceTreatAsPermanent: true });
        } else {
          await this.pushFrame(frame, direction);
        }
      }
    })();
    const worker = new PipelineWorker(new Pipeline([permanent]), {
      cancelOnIdleTimeout: false,
      idleTimeoutSecs: null,
      processorUnusablePolicy: ProcessorUnusablePolicy.CANCEL,
    });
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const pipeline = yield* startPipeline(worker);
          yield* pipeline.queueFrame(new TextFrame({ text: "x" }));
          yield* pipeline.join;
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause) as PipelineError;
      expect(error._tag).toBe("PipelineError");
      expect(error.frame?.error).toBe("gone");
    }
  });

  test("a worker that throws fails join with a PipelineError", async () => {
    const worker = new (class extends PipelineWorker {
      override async run(): Promise<void> {
        throw new Boom("run failed");
      }
    })(new Pipeline([]), { cancelOnIdleTimeout: false, idleTimeoutSecs: null });
    const exit = await run(runPipeline(worker));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect((Cause.squash(exit.cause) as PipelineError).cause).toBeInstanceOf(Boom);
    }
  });

  test("a defect in a processor Effect becomes an ErrorFrame", async () => {
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const dying = yield* makeProcessor((frame, direction, ctx) =>
            isDownText(frame, direction)
              ? Effect.die(new Boom("defect"))
              : forward(frame, direction, ctx),
          );
          const pipeline = yield* startPipeline(makeWorker([dying]), { failOnError: true });
          yield* pipeline.queueFrame(new TextFrame({ text: "x" }));
          yield* pipeline.join;
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect((Cause.squash(exit.cause) as PipelineError).frame?.exception).toBeInstanceOf(Boom);
    }
  });
});

function forwarder(): FrameProcessor {
  return new (class extends FrameProcessor {
    override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
      await super.processFrame(frame, direction);
      await this.pushFrame(frame, direction);
    }
  })();
}
