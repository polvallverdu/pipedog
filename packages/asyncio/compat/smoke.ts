// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: exercises task cancellation (which
// needs AsyncLocalStorage), queues and waitFor timeouts on the target runtime.

import {
  CancelledError,
  createTask,
  currentTask,
  Queue,
  sleep,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`asyncio smoke: ${message}`);
}

export default async function smoke(): Promise<void> {
  // A task cancelled while it sleeps sees CancelledError at the sleep.
  let reachedSleep = false;
  let sawCancel = false;
  let afterSleep = false;
  const task = createTask(async () => {
    check(currentTask() === task, "currentTask() inside a task");
    reachedSleep = true;
    try {
      await sleep(10);
      afterSleep = true;
    } catch (e) {
      sawCancel = e instanceof CancelledError;
      throw e;
    }
  }, "sleeper");
  await sleep(0.01);
  check(reachedSleep, "task did not start");
  task.cancel();
  let awaitedCancel = false;
  try {
    await task;
  } catch (e) {
    awaitedCancel = e instanceof CancelledError;
  }
  check(sawCancel, "task did not see CancelledError at sleep()");
  check(!afterSleep, "sleep() returned after cancel");
  check(awaitedCancel, "awaiting a cancelled task did not throw CancelledError");
  check(task.cancelled(), "task.cancelled() is false");

  // Queue: FIFO order, a blocked get() woken by put().
  const queue = new Queue<number>();
  const consumer = createTask(async () => [await queue.get(), await queue.get()]);
  await sleep(0);
  await queue.put(1);
  await queue.put(2);
  const got = await consumer;
  check(got[0] === 1 && got[1] === 2, `queue order ${JSON.stringify(got)}`);
  check(queue.empty(), "queue not empty");

  // waitFor: a timeout raises TimeoutError and cancels the inner coroutine.
  let innerCancelled = false;
  let timedOut = false;
  try {
    await waitFor(async () => {
      try {
        await sleep(10);
      } catch (e) {
        innerCancelled = e instanceof CancelledError;
        throw e;
      }
    }, 0.02);
  } catch (e) {
    timedOut = e instanceof TimeoutError;
  }
  check(timedOut, "waitFor did not raise TimeoutError");
  check(innerCancelled, "waitFor did not cancel the inner coroutine");
  check((await waitFor(async () => 42, 1)) === 42, "waitFor result");
}
