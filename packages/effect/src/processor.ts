// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Frame processors written as Effect functions.
//
// `processFrame` forks the user's Effect for the frame and waits for it on an
// asyncio future, which is a cancellation point. So:
//
//   - cancelling the processor's task (the pipeline being cancelled, or an
//     interruption cancelling the processing of a non-system frame) interrupts
//     the fiber and waits for its finalizers before re-raising CancelledError;
//   - frames the Effect pushes are pushed by the processor's own task, in
//     order, as a Python processor would push them from `process_frame`;
//   - a failure or defect of the Effect becomes `pushError` on the processor.
//
// The fiber is forked from a `callSoon` callback, outside any asyncio task, so
// asyncio calls made by the Effect never run as the processor's task.

import {
  CancelledError,
  callSoon,
  Future,
  rethrowIfCancelled,
  Queue as TaskQueue,
} from "@pipedog/asyncio";
import type { Frame } from "@pipedog/core/frames/frames";
import {
  FrameDirection,
  FrameProcessor,
  type FrameProcessorOptions,
} from "@pipedog/core/processors/frame_processor";
import { logger } from "@pipedog/core/utils/logger";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";

import { runInTask } from "./bridge.ts";

/** What a processing Effect gets besides the frame. */
export interface ProcessFrameContext {
  /** The processor running the Effect. */
  readonly processor: EffectFrameProcessor<any, any>;
  /**
   * Push a frame to the next (downstream) or previous (upstream) processor.
   * Completes once the processor has pushed it.
   */
  push(frame: Frame, direction?: FrameDirection): Effect.Effect<void>;
}

/**
 * Handles one frame. Like a processor's `processFrame`, it sees every frame
 * (system frames included) and pushes the ones that go on, usually with
 * `ctx.push(frame, direction)`.
 */
export type ProcessFrameEffect<E, R> = (
  frame: Frame,
  direction: FrameDirection,
  ctx: ProcessFrameContext,
) => Effect.Effect<void, E, R>;

type Message<E> =
  | { kind: "push"; frame: Frame; direction: FrameDirection; done: Future<void> }
  | { kind: "exit"; exit: Exit.Exit<void, E> };

/**
 * A `FrameProcessor` whose `processFrame` runs an Effect. Build one with
 * `makeProcessor`, which provides the services it needs.
 */
export class EffectFrameProcessor<E = never, R = never> extends FrameProcessor {
  readonly #fn: ProcessFrameEffect<E, R>;
  readonly #context: Context.Context<R>;

  constructor(
    fn: ProcessFrameEffect<E, R>,
    context: Context.Context<R>,
    options: FrameProcessorOptions = {},
  ) {
    super(options);
    this.#fn = fn;
    this.#context = context;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);

    // The processor's task reads this mailbox until the fiber is done, doing
    // the pushes the fiber asks for in between.
    const mailbox = new TaskQueue<Message<E>>();
    let open = true;
    const ctx: ProcessFrameContext = {
      processor: this,
      push: (pushed, pushDirection = FrameDirection.DOWNSTREAM) => {
        // A fiber forked by the Effect may push after it has returned:
        // that push runs in a task of its own.
        if (!open) return runInTask(() => this.pushFrame(pushed, pushDirection), "effect-push");
        return Effect.callback<void>((resume) => {
          const done = new Future<void>();
          done.addDoneCallback(() => {
            if (done.cancelled()) resume(Effect.interrupt);
            else if (done.exception() !== undefined) resume(Effect.die(done.exception()));
            else resume(Effect.void);
          });
          mailbox.putNowait({ kind: "push", frame: pushed, direction: pushDirection, done });
        });
      },
    };

    let fiber: Fiber.Fiber<void, E> | undefined;
    const fork = callSoon(() => {
      fiber = Effect.runForkWith(this.#context)(this.#fn(frame, direction, ctx));
      fiber.addObserver((exit) => mailbox.putNowait({ kind: "exit", exit }));
    });

    let exit: Exit.Exit<void, E> | undefined;
    let pushing: Future<void> | null = null;
    try {
      while (exit === undefined) {
        const message = await mailbox.get();
        if (message.kind === "exit") {
          exit = message.exit;
          continue;
        }
        pushing = message.done;
        try {
          await this.pushFrame(message.frame, message.direction);
          message.done.setResult(undefined);
        } catch (e) {
          rethrowIfCancelled(e);
          // The push failed: a defect in the fiber that asked for it.
          message.done.setException(e);
        }
        pushing = null;
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        // Cancelled from the pipeline side: interrupt the Effect and wait
        // for its finalizers before letting the cancellation through.
        fork.cancel();
        await this.#interrupt(fiber, mailbox);
      }
      throw e;
    } finally {
      open = false;
      if (pushing && !pushing.done()) pushing.cancel();
      for (const pending of drain(mailbox)) {
        if (pending.kind === "push" && !pending.done.done()) pending.done.cancel();
      }
    }

    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) {
        logger.debug(`${this}: processing ${frame} was interrupted`);
      } else {
        const error = Cause.squash(exit.cause);
        await this.pushError(`${this}: ${error instanceof Error ? error.message : error}`, {
          exception: error,
        });
      }
    }
  }

  async #interrupt(
    fiber: Fiber.Fiber<void, E> | undefined,
    mailbox: TaskQueue<Message<E>>,
  ): Promise<void> {
    if (!fiber || fiber.pollUnsafe() !== undefined) return;
    fiber.interruptUnsafe();
    // Pushes requested while interrupting are not done: the task is going away.
    while (true) {
      const message = await mailbox.get();
      if (message.kind === "exit") return;
      message.done.cancel();
    }
  }
}

function* drain<T>(queue: TaskQueue<T>): Generator<T> {
  while (!queue.empty()) yield queue.getNowait();
}

/**
 * Build a `FrameProcessor` from an Effect function. The returned Effect
 * captures the services `R` the function needs from the current context, so
 * the processor's dependencies are provided with Layers like any other
 * Effect code (and swapped in tests).
 *
 * @example
 * const upper = yield* makeProcessor((frame, direction, ctx) =>
 *   frame instanceof TextFrame && direction === FrameDirection.DOWNSTREAM
 *     ? ctx.push(new TextFrame({ text: frame.text.toUpperCase() }))
 *     : ctx.push(frame, direction),
 * );
 */
export function makeProcessor<E = never, R = never>(
  fn: ProcessFrameEffect<E, R>,
  options: FrameProcessorOptions = {},
): Effect.Effect<EffectFrameProcessor<E, R>, never, R> {
  return Effect.map(
    Effect.context<R>(),
    (context) => new EffectFrameProcessor(fn, context, options),
  );
}
