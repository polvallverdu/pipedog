// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/interruptions-and-cancellation.mdx.
// Type-checked on every docs build.

// #region tasks
import {
  abortable,
  CancelledError,
  createTask,
  currentSignal,
  Event,
  gather,
  Queue,
  rethrowIfCancelled,
  sleep,
  TimeoutError,
  waitFor,
} from "@pipedog/asyncio";

const task = createTask(async () => {
  await sleep(10); // a cancellation point
  return "done";
}, "slow-task");

task.cancel(); // like asyncio: the pending sleep() rejects with CancelledError
try {
  await task;
} catch (e) {
  console.log(e instanceof CancelledError); // true
}
// #endregion tasks

// #region wait-for
try {
  // Pass a function, so it runs as a child task that can be cancelled on timeout.
  await waitFor(() => sleep(5), 0.1);
} catch (e) {
  if (!(e instanceof TimeoutError)) throw e;
}

const [x, y] = await gather(
  async () => 1,
  async () => "two",
);
// #endregion wait-for
void x;
void y;

// #region queue-event
const queue = new Queue<string>();
const ready = new Event();

const consumer = createTask(async () => {
  await ready.wait();
  for (;;) {
    const item = await queue.get(); // a cancellation point
    console.log("got", item);
    queue.taskDone();
  }
});

ready.set();
await queue.put("hello");
await queue.join();
consumer.cancel();
// #endregion queue-event

// #region rethrow
async function callProvider(url: string): Promise<unknown> {
  try {
    // fetch is not a cancellation point. Give it the current task's signal
    // so cancelling the task aborts the request too.
    const response = await fetch(url, { signal: currentSignal() });
    return await response.json();
  } catch (e) {
    rethrowIfCancelled(e); // Python's `except Exception` never catches CancelledError
    console.error("provider failed", e);
    return null;
  }
}
// #endregion rethrow

// #region abortable
async function withSdk(sdkCall: () => Promise<string>): Promise<string> {
  // An SDK that takes no AbortSignal: turn the await into a cancellation point.
  // The SDK call itself keeps running in the background if we are cancelled.
  return await abortable(sdkCall());
}
// #endregion abortable

void callProvider;
void withSdk;
