# @pipedog/asyncio

Python asyncio semantics for JavaScript runtimes: tasks with cooperative cancellation
(`CancelledError`), futures, `sleep`, `waitFor`, `gather`, `wait`, `shield`, queues (`Queue`,
`LifoQueue`, `PriorityQueue`), `Event`, `Lock` and `Semaphore`. Scheduling follows asyncio's: a
task runs until it awaits a future that is not done. pipedog's ported code depends on this to
behave like Pipecat.

This package has no upstream module of its own: it stands in for Python's standard `asyncio`, which
Pipecat is built on. Durations are in seconds, as in Python.

## Install

```sh
bun add @pipedog/asyncio
```

No peer dependencies.

## Usage

```ts
import { CancelledError, createTask, rethrowIfCancelled, sleep } from "@pipedog/asyncio";

const task = createTask(async () => {
  try {
    await sleep(10);
  } catch (e) {
    rethrowIfCancelled(e); // never swallow a cancellation in a broad catch
    console.error(e);
  }
}, "sleeper");

task.cancel();
try {
  await task;
} catch (e) {
  console.log(e instanceof CancelledError); // true
}
```

Every await on a future (and so on `sleep`, `Queue.get`, `Event.wait`, awaiting a task) is a
cancellation point. For foreign awaits such as `fetch`, pass the task's `signal` or wrap them in
`abortable()`.

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers. The current task is tracked with
`AsyncLocalStorage` from `node:async_hooks`, so Workers need the `nodejs_compat` flag.

On Bun, Node and Deno, callbacks run from one ready queue, as in CPython. On Workers, where one
isolate serves many requests and Durable Objects, each callback runs in the I/O context that
scheduled it (still in FIFO order), so concurrent Durable Objects never do each other's I/O.

## Links

- Docs: [asyncio API](https://polvallverdu.github.io/pipedog/docs/api/asyncio/),
  [interruptions and cancellation](https://polvallverdu.github.io/pipedog/docs/concepts/interruptions-and-cancellation/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause. See [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
