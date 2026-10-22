// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The two primitives every crossing between Effect and @pipedog/asyncio goes
// through.
//
// Effect fibers and asyncio tasks are separate schedulers with separate
// cancellation models: a fiber is interrupted, a task is cancelled (it gets a
// CancelledError at its next cancellation point). The rules this file keeps:
//
//   - asyncio work started from Effect runs in a task of its own (never in
//     whatever task the fiber happens to have been started from), so it has
//     its own cancellation state and never blocks someone else's task;
//   - interrupting the fiber cancels that task and waits until it is done, so
//     nothing outlives the Effect that started it;
//   - a task that ends cancelled interrupts the fiber waiting on it: an
//     asyncio cancellation becomes an Effect interruption.

import { CancelledError, createTask, type Future, type Task } from "@pipedog/asyncio";
import * as Effect from "effect/Effect";

/**
 * Wait until `future` (or task) is done, without consuming its outcome.
 * Interrupting the wait only stops waiting.
 */
export function awaitDone(future: Future<unknown>): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (future.done()) {
      resume(Effect.void);
      return;
    }
    const onDone = () => resume(Effect.void);
    future.addDoneCallback(onDone);
    return Effect.sync(() => {
      future.removeDoneCallback(onDone);
    });
  });
}

/**
 * The outcome of a done task as an Effect: its value, an interruption if it
 * was cancelled, or a defect if it failed.
 */
export function taskOutcome<A>(task: Task<A>): Effect.Effect<A> {
  if (task.cancelled()) return Effect.interrupt;
  try {
    return Effect.succeed(task.result());
  } catch (e) {
    if (e instanceof CancelledError) return Effect.interrupt;
    return Effect.die(e);
  }
}

/**
 * Run `fn` in a new asyncio task and wait for it. Interrupting the Effect
 * cancels the task and waits for it to finish; the task ending cancelled
 * interrupts the Effect; an error becomes a defect.
 */
export function runInTask<A>(fn: () => Promise<A> | A, name?: string): Effect.Effect<A> {
  return Effect.suspend(() => {
    const task = createTask(fn, name);
    return Effect.callback<A>((resume) => {
      if (task.done()) {
        resume(taskOutcome(task));
        return;
      }
      const onDone = () => resume(taskOutcome(task));
      task.addDoneCallback(onDone);
      return Effect.suspend(() => {
        task.removeDoneCallback(onDone);
        task.cancel();
        return awaitDone(task);
      });
    });
  });
}
