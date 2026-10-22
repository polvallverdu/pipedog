// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A PipelineWorker as a scoped Effect resource.
//
// Acquiring the resource adds the worker to a WorkerRunner of its own and
// starts `runner.run()` in an asyncio task. Closing the scope cancels the
// runner (which cancels the worker) and waits until it has finished, so an
// interrupted fiber never leaves pipeline tasks behind. In the other
// direction, `join` reports how the pipeline ended: a pipeline that ended
// (EndFrame/StopFrame) succeeds, one that failed fails with a PipelineError,
// and one that was cancelled from the pipeline side interrupts the fiber.

import { CancelledError, createTask, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import { EndFrame, type ErrorFrame, Frame, StopFrame } from "@pipedog/core/frames/frames";
import type { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import type { FrameClass } from "@pipedog/core/utils/frame_queue";
import type { WorkerParams } from "@pipedog/core/workers/base_worker";
import { WorkerRunner, type WorkerRunnerOptions } from "@pipedog/core/workers/runner";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { awaitDone, runInTask } from "./bridge.ts";

/**
 * Why a pipeline run failed.
 *
 * - `frame` is set when an `ErrorFrame` ended the run: any error with
 *   `failOnError`, otherwise one from a processor that can no longer do its
 *   job (`frame.processor.isUsable === false`) when the pipeline then stopped.
 * - `cause` is set when the worker or runner threw.
 */
export class PipelineError extends Data.TaggedError("PipelineError")<{
  readonly message: string;
  readonly frame?: ErrorFrame | undefined;
  readonly cause?: unknown;
}> {}

export interface PipelineOptions {
  /**
   * Options for the `WorkerRunner` that runs the worker. Signal handling is
   * off by default (`handleSigint: false`): an Effect app handles signals
   * with its runtime (e.g. `NodeRuntime.runMain`), whose interruption cancels
   * the pipeline.
   */
  runner?: WorkerRunnerOptions;
  /**
   * Fail with a `PipelineError` on the first `ErrorFrame` that reaches the
   * worker, cancelling the pipeline. Default false: errors are reported by
   * the pipeline as usual and the run fails only if the pipeline stops
   * because of an unusable processor.
   */
  failOnError?: boolean;
  /** Reason given to the runner when closing the scope cancels a running pipeline. */
  cancelReason?: string;
}

/** A running pipeline, as handed out by `startPipeline`. */
export interface PipelineHandle {
  /** The worker being run. */
  readonly worker: PipelineWorker;
  /**
   * Wait for the pipeline to end. Succeeds if it ended with an `EndFrame` or
   * `StopFrame`, fails with a `PipelineError` if it failed, and is
   * interrupted if it was cancelled (by `cancel`, a `CancelWorkerFrame`, a
   * `ProcessorUnusablePolicy` or anything else on the pipeline side).
   * Interrupting `join` only stops waiting; closing the scope is what
   * cancels the pipeline.
   */
  readonly join: Effect.Effect<void, PipelineError>;
  /** Queue a frame (`PipelineWorker.queueFrame`). */
  queueFrame(frame: Frame, direction?: FrameDirection): Effect.Effect<void>;
  /**
   * Queue frames from an iterable or a `Stream`, in order, until it ends.
   * Interrupting the Effect stops reading the stream.
   */
  queueFrames<E = never, R = never>(
    frames: Iterable<Frame> | Stream.Stream<Frame, E, R>,
    direction?: FrameDirection,
  ): Effect.Effect<void, E, R>;
  /**
   * Subscribe to the frames of the given classes (any frame if none) that
   * reach the end of the pipeline. The subscription starts when this Effect
   * runs, so subscribe before queueing the frames you want to see; it lasts
   * until the scope closes. The stream ends when the pipeline has finished.
   * Frames are buffered without bound until the stream reads them.
   */
  frames<T extends Frame = Frame>(
    ...types: FrameClass<T>[]
  ): Effect.Effect<Stream.Stream<T>, never, Scope.Scope>;
  /** End the pipeline gracefully once queued frames are processed (`stopWhenDone`). */
  readonly stopWhenDone: Effect.Effect<void>;
  /** Cancel the pipeline now. `join` is then interrupted. */
  cancel(reason?: string): Effect.Effect<void>;
}

interface Subscriber {
  types: readonly FrameClass[];
  queue: Queue.Queue<Frame, Cause.Done>;
}

class Handle implements PipelineHandle {
  readonly worker: PipelineWorker;
  readonly #runner: WorkerRunner;
  readonly #options: PipelineOptions;
  #runTask: Task<void> | null = null;
  #subscribers = new Set<Subscriber>();
  #closed = false;
  // How the run ended, filled in by the worker's event handlers.
  #ended = false;
  #failFrame: ErrorFrame | null = null;
  #unusableFrame: ErrorFrame | null = null;
  #runError: { error: unknown } | null = null;

  constructor(worker: PipelineWorker, options: PipelineOptions) {
    this.worker = worker;
    this.#options = options;
    this.#runner = new WorkerRunner({ handleSigint: false, ...options.runner });
  }

  readonly #onFinished = async (_worker: unknown, frame: Frame): Promise<void> => {
    // Upstream also reports a cancelled pipeline as finished (with the
    // CancelFrame); only an EndFrame or StopFrame is a normal end.
    if (frame instanceof EndFrame || frame instanceof StopFrame) this.#ended = true;
  };

  readonly #onError = async (_worker: unknown, frame: ErrorFrame): Promise<void> => {
    if (frame.processor && !frame.processor.isUsable) this.#unusableFrame ??= frame;
    if (this.#options.failOnError && this.#failFrame === null) {
      this.#failFrame = frame;
      await this.worker.cancel({ reason: `pipeline error: ${frame.error}` });
    }
  };

  readonly #onFrame = async (_worker: unknown, frame: Frame): Promise<void> => {
    for (const subscriber of this.#subscribers) {
      if (subscriber.types.some((type) => frame instanceof type)) {
        Queue.offerUnsafe(subscriber.queue, frame);
      }
    }
  };

  /** Start the runner. Runs uninterruptibly, as the acquire step. */
  start(): Effect.Effect<this> {
    return Effect.suspend(() => {
      const worker = this.worker;
      worker.addEventHandler("on_pipeline_finished", this.#onFinished);
      worker.addEventHandler("on_pipeline_error", this.#onError);
      worker.addEventHandler("on_frame_reached_downstream", this.#onFrame);

      // WorkerRunner swallows an error thrown by a worker's
      // run() (the worker's task fails and the runner just ends), so the
      // error is recorded here, on this instance, to fail `join` with it.
      const run = worker.run;
      const record = (e: unknown) => {
        this.#runError ??= { error: e };
      };
      worker.run = async function (this: PipelineWorker, params: WorkerParams): Promise<void> {
        try {
          await run.call(this, params);
        } catch (e) {
          rethrowIfCancelled(e);
          record(e);
          throw e;
        }
      };

      return runInTask(() => this.#runner.addWorkers(worker), `effect-add-${worker.name}`).pipe(
        Effect.map(() => {
          const task = createTask(() => this.#runner.run(), `effect-run-${worker.name}`);
          this.#runTask = task;
          task.addDoneCallback(() => this.#endSubscribers());
          return this;
        }),
      );
    });
  }

  /** Cancel the run if it is still going and wait for it to finish. */
  close(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.#closed = true;
      const task = this.#runTask;
      const done = () => {
        this.worker.removeEventHandler("on_frame_reached_downstream", this.#onFrame);
        this.#endSubscribers();
      };
      if (!task || task.done()) return Effect.sync(done);
      const reason = this.#options.cancelReason ?? "scope closed";
      return runInTask(() => this.#runner.cancel(reason), `effect-cancel-${this.worker.name}`).pipe(
        Effect.andThen(awaitDone(task)),
        Effect.ensuring(Effect.sync(done)),
      );
    });
  }

  get join(): Effect.Effect<void, PipelineError> {
    return Effect.suspend(() => {
      const task = this.#runTask;
      if (!task) return Effect.interrupt;
      return Effect.andThen(awaitDone(task), () => this.#outcome(task));
    });
  }

  #outcome(task: Task<void>): Effect.Effect<void, PipelineError> {
    const name = this.worker.name;
    if (this.#runError) {
      const cause = this.#runError.error;
      return Effect.fail(
        new PipelineError({ message: `pipeline ${name} failed: ${describe(cause)}`, cause }),
      );
    }
    if (!task.cancelled()) {
      try {
        task.result();
      } catch (e) {
        if (!(e instanceof CancelledError)) {
          return Effect.fail(
            new PipelineError({ message: `pipeline ${name} failed: ${describe(e)}`, cause: e }),
          );
        }
      }
    }
    if (this.#failFrame) return Effect.fail(errorFromFrame(name, this.#failFrame));
    if (this.#ended) return Effect.void;
    if (this.#unusableFrame) return Effect.fail(errorFromFrame(name, this.#unusableFrame));
    // Cancelled: from the scope, `cancel()`, or the pipeline itself.
    return Effect.interrupt;
  }

  queueFrame(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) {
    return runInTask(() => this.worker.queueFrame(frame, direction), "effect-queue-frame");
  }

  queueFrames<E = never, R = never>(
    frames: Iterable<Frame> | Stream.Stream<Frame, E, R>,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Effect.Effect<void, E, R> {
    if (Stream.isStream(frames)) {
      return Stream.runForEach(frames as Stream.Stream<Frame, E, R>, (frame) =>
        this.queueFrame(frame, direction),
      );
    }
    return runInTask(() => this.worker.queueFrames(frames, direction), "effect-queue-frames");
  }

  frames<T extends Frame = Frame>(
    ...types: FrameClass<T>[]
  ): Effect.Effect<Stream.Stream<T>, never, Scope.Scope> {
    const wanted: readonly FrameClass[] = types.length > 0 ? types : [Frame];
    return Effect.acquireRelease(
      Effect.map(Queue.unbounded<Frame, Cause.Done>(), (queue) => {
        const subscriber: Subscriber = { types: wanted, queue };
        this.worker.addReachedDownstreamFilter(wanted);
        if (this.#closed || this.#runTask?.done()) Queue.endUnsafe(queue);
        else this.#subscribers.add(subscriber);
        return subscriber;
      }),
      (subscriber) =>
        Effect.sync(() => {
          this.#subscribers.delete(subscriber);
          Queue.endUnsafe(subscriber.queue);
        }),
    ).pipe(Effect.map((subscriber) => Stream.fromQueue(subscriber.queue) as Stream.Stream<T>));
  }

  get stopWhenDone(): Effect.Effect<void> {
    return runInTask(() => this.worker.stopWhenDone(), "effect-stop-when-done");
  }

  cancel(reason?: string): Effect.Effect<void> {
    return runInTask(
      () => this.worker.cancel({ reason: reason ?? null }),
      `effect-cancel-${this.worker.name}`,
    );
  }

  #endSubscribers(): void {
    for (const subscriber of this.#subscribers) Queue.endUnsafe(subscriber.queue);
    this.#subscribers.clear();
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errorFromFrame(name: string, frame: ErrorFrame): PipelineError {
  return new PipelineError({
    message: `pipeline ${name} error: ${frame.error}`,
    frame,
    cause: frame.exception ?? undefined,
  });
}

/**
 * Run a `PipelineWorker` for the lifetime of the current `Scope`.
 *
 * The worker is added to a `WorkerRunner` of its own, which starts running in
 * the background. When the scope closes, a pipeline that is still running is
 * cancelled and the scope waits for it to finish (its processors cleaned up
 * and its tasks done), so interrupting the fiber that owns the scope cancels
 * the pipeline without leaking tasks.
 *
 * @example
 * const program = Effect.scoped(
 *   Effect.gen(function* () {
 *     const pipeline = yield* startPipeline(worker);
 *     const texts = yield* pipeline.frames(TextFrame);
 *     yield* pipeline.queueFrames([new TextFrame({ text: "hi" }), new EndFrame()]);
 *     const received = yield* Stream.runCollect(texts);
 *     yield* pipeline.join;
 *   }),
 * );
 */
export function startPipeline(
  worker: PipelineWorker,
  options: PipelineOptions = {},
): Effect.Effect<PipelineHandle, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.suspend(() => new Handle(worker, options).start()),
    (handle) => handle.close(),
  );
}

/**
 * Run a `PipelineWorker` until it ends: `startPipeline` and `join` in a scope
 * of their own. Interrupting the Effect cancels the pipeline and waits for
 * it; a pipeline cancelled from its side interrupts the Effect; a failed one
 * fails it with a `PipelineError`.
 */
export function runPipeline(
  worker: PipelineWorker,
  options: PipelineOptions = {},
): Effect.Effect<void, PipelineError> {
  return Effect.scoped(Effect.flatMap(startPipeline(worker, options), (handle) => handle.join));
}
