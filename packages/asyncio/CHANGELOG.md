# @pipedog/asyncio

## 0.8.0

No changes in this release.

## 0.7.0

No changes in this release.

## 0.6.1

### Patch Changes

- [#43](https://github.com/polvallverdu/pipedog/pull/43) [`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac) Thanks [@polvallverdu](https://github.com/polvallverdu)! - README: explain how callbacks are scheduled on Cloudflare Workers (each in the I/O context that
  scheduled it), so concurrent Durable Objects don't do each other's I/O.

## 0.6.0

### Patch Changes

- [#42](https://github.com/polvallverdu/pipedog/pull/42) [`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b) Thanks [@polvallverdu](https://github.com/polvallverdu)! - On Cloudflare Workers, loop callbacks run in the I/O context that scheduled them. One isolate
  serves many requests and Durable Objects, and the shared ready queue could run one session's
  callbacks during another's turn, so its I/O failed with "Cannot perform I/O on behalf of a
  different Durable Object" (or "request"), and tasks those callbacks created stayed in the wrong
  context. Parallel voice sessions on Durable Objects could lose their speech-to-text connection or
  their WebSocket output this way.

## 0.5.0

### Patch Changes

- [#20](https://github.com/polvallverdu/pipedog/pull/20) [`566fb45`](https://github.com/polvallverdu/pipedog/commit/566fb45374cac73be72f2a83510a12b6b8041301) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Package READMEs on npm. `@pipedog/core`, `@pipedog/asyncio`, `@pipedog/openai`,
  `@pipedog/anthropic`, `@pipedog/deepgram`, `@pipedog/cartesia`, `@pipedog/elevenlabs`,
  `@pipedog/tracing` and `@pipedog/whisper` now ship a README with install steps, a usage snippet,
  runtimes and links to the docs. Every package gains npm `keywords`, and the `@pipedog/elevenlabs`
  description no longer lists Text-to-Dialogue, which is not ported yet.

## 0.4.0

No changes in this release.

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
