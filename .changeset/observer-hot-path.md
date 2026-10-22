---
"@pipedog/core": minor
---

Frames move through a pipeline about twice as fast (per-frame latency through 10 processors: 83 → 40 µs on Node, 370 → 180 µs on Cloudflare Workers), with the same behavior:

- The pipeline worker no longer wakes an observer for events it doesn't handle: `onProcessFrame` events only go to observers that override `onProcessFrame` (the default observers only watch pushes).
- New `BaseObserver.acceptsPush(data)`: a synchronous filter the worker calls before queueing a push for an observer. `RTVIObserver` uses it to skip the repeated pushes it ignores, so it is no longer woken at every hop of every frame.
- `FrameProcessor` skips the per-frame `on_before/after_process_frame` and `on_before/after_push_frame` events when nothing listens to them, and builds its trace log line only when trace logging is on.
