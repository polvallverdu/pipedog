---
"@pipedog/asyncio": patch
---

Calling `task.then(cb)` on a `Task` from inside another task no longer makes the caller wait on it.
Before, the caller could become impossible to cancel, and a processor that did this hung the
pipeline's `cleanup()` (#96). `await task`, `Promise.all` and `Promise.resolve(task)` still suspend
the caller, so cancelling it cancels the awaited task, as in asyncio.
