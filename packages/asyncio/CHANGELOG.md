# @pipedog/asyncio

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- [#7](https://github.com/polvallverdu/pipedog/pull/7) [`122b72f`](https://github.com/polvallverdu/pipedog/commit/122b72fb4167cf2b12112d83de5ed255c9e0d897) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `@pipedog/asyncio` now schedules like asyncio, so ported code interleaves exactly as it does in
  Python. Waking a waiter (a future's result, `Event.set()`, `Queue.put()`, a task finishing, a
  timer) no longer resumes it on the next microtask: the wakeup goes on a FIFO ready queue
  (`callSoon`), and queued wakeups run one at a time, each once the microtask queue is empty. A task
  therefore runs until it awaits something that is not done; `get()` on a non-empty queue, `put()` on
  an unbounded one, `wait()` on a set event and awaiting a done task do not let any other task run,
  and `sleep(0)` yields exactly one turn. The turn is driven by a MessageChannel on Node,
  `setImmediate` on Bun and Deno, and a body read on Cloudflare Workers.
  
  - New: `Future` (asyncio.Future: `setResult`, `setException`, `cancel`, done callbacks; awaitable),
    `callSoon` / `callLater` returning a cancellable `Handle`, `isFuture`. `Task` extends `Future`.
  - `Event`, `Queue` (and `PriorityQueue`, `LifoQueue`), `Lock`, `Semaphore`, `gather`, `wait`,
    `shield`, `waitFor` and `timeout` are ported from CPython on top of `Future`, with its wakeup
    rules: a woken `get()` takes whatever is at the head when it runs (so a `PriorityQueue` hands
    out the smallest item of a burst), a cancellation that arrives after the wakeup was queued wins,
    `gather` raises a cancellation once its children are done, and `addDoneCallback` callbacks run
    on the ready queue.
  - `waitFor(fn, t)` and `timeout(t, fn)` run `fn` in the current task, like Python 3.12+: on
    expiry the task is cancelled and the `CancelledError` becomes `TimeoutError`. When every
    cancellation request has been withdrawn with `uncancel()`, `task.signal` is a fresh signal.
  - `Queue` uses O(1) removal from the front (it used `Array.shift()`, which is O(n) on V8 and made
    long queues quadratic on Node, Deno and Workers).
  - 32 interleaving scenarios recorded from CPython 3.14 (`test/python/scenarios.py`) are replayed in
    the tests and in the compat smoke test on all four runtimes.
  
  `@pipedog/core`: `LLMAssistantAggregator` runs the LLM once for a burst of
  `LLMMessagesAppendFrame` / `FunctionCallResultFrame` instead of once per frame. Its
  `hasQueuedFrame(...)` check now sees the later frames of the burst queued, as upstream does, so
  there are no more duplicate responses. Other frame orderings that depend on asyncio scheduling
  (system frames overtaking queued data frames, bus priority, interruption handling) now match
  upstream too.

## 0.1.0

No changes in this release.
