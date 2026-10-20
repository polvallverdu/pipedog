# Porting conventions

This is the rulebook for porting Pipecat (Python) to pipedog. It is written
for humans and for the porting agents (`.claude/workflows/port.js`). When a
case is not covered, look at how the hand-ported reference files do it:

| Reference file | Shows |
|---|---|
| `packages/asyncio/src/*` | asyncio semantics in JS (tasks, cancellation, queues) |
| `packages/core/src/processors/frame_processor.ts` | a full class port: options, privates, events, cancellation, errors |
| `packages/core/src/utils/base_object.ts` | event handlers, tasks |
| `packages/core/src/frames/frames.ts` (top) | frames, dataclasses, mixins |
| `packages/core/src/utils/frame_queue.ts` | subclassing asyncio queues |

## Goals, in priority order

1. **Behavioral parity.** Same frames in the same order, the same lifecycle,
   and the same wire formats (RTVI, serializers), so pipecat clients
   (`@pipecat-ai/client-js`, voice-ui-kit, the prebuilt UIs) work unchanged.
   The upstream test suite, ported 1:1, is how we prove it.
2. **Recognizable API.** Someone who knows Pipecat Python can read our code
   and our docs. Class names, event names, module paths and file names are the
   same; only the casing of members changes (see Naming).
3. **Runs everywhere.** `@pipedog/core` runs on Bun, Node ≥ 22, Deno and
   Cloudflare Workers. Runtime-specific code lives in its own package.
4. **Idiomatic TypeScript** where that doesn't conflict with 1–3.

## Layout

- One Python module → one TS file, at the same path, with the same snake_case
  name: `src/pipecat/processors/frame_processor.py` →
  `packages/core/src/processors/frame_processor.ts`. Consumers import
  `@pipedog/core/processors/frame_processor`.
- `__init__.py` that only re-exports → `index.ts`. An `__init__.py` with code
  → `index.ts` holding that code.
- One Python test file → one TS test file: `tests/test_frame_processor.py` →
  `packages/<pkg>/test/test_frame_processor.test.ts`.
- **Packages.** The core import closure (frames, processors base, pipeline,
  workers, bus, observers, RTVI, base transports and services, turns, utils)
  is mutually dependent, so it is one package, `@pipedog/core`.
  Everything outside it gets its own package:
  - `services/<provider>` → `@pipedog/<provider>`
  - `transports/<name>` → `@pipedog/transport-<name>`
  - `serializers/<name>` → `@pipedog/serializer-<name>` (base serializers stay in core)
  - audio filters, VAD and turn models → `@pipedog/<name>`
  - `flows`, `evals`, `runner`, `cli` → their own packages.
  `porting/manifest.json` records the assignment for every module.
- Every `package.json` has a `"pipecat"` block:
  ```json
  "pipecat": {
    "runtimes": ["bun", "node", "deno", "workerd"],
    "upstream": ["src/pipecat/services/deepgram"]
  }
  ```
  `runtimes` lists only what is verified (a smoke test imports it there). It
  generates the compatibility table in the docs.

## File header

Every ported file starts with:

```ts
// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/<path>.py
```

Files we write ourselves (no upstream counterpart) omit the Daily line and the
"Ported from" line. `bun run lint` checks this. The upstream commit lives in
`porting/manifest.json`, not in the header, so re-syncing doesn't touch every file.

## Naming

| Python | TypeScript |
|---|---|
| `ClassName` | `ClassName` (unchanged) |
| `def snake_case()` / `snake_case` attribute | `camelCase` |
| `_protected` | `_protected` (camelCase, keep the underscore), `protected` |
| `__private` (name-mangled) | `#private` |
| `CONSTANT` | `CONSTANT` |
| module `snake_case.py` | `snake_case.ts` |
| event names `"on_pipeline_started"` | **unchanged strings** |
| dict keys / JSON on the wire | **unchanged** (a protocol is not an API) |
| acronyms: `LLMService`, `start_llm_usage_metrics`, `tts_text` | `LLMService`, `startLlmUsageMetrics`, `ttsText` |

## Constructors and parameters

Python keyword arguments become one **options object**:

```python
def __init__(self, *, name: str | None = None, enable_direct_mode: bool = False, **kwargs)
```
```ts
export interface FrameProcessorOptions extends BaseObjectOptions {
  enableDirectMode?: boolean;
}
constructor(options: FrameProcessorOptions = {}) { super(options); ... }
```

- The options interface is named `<Class>Options` and extends the parent's.
  Pass the whole object to `super(options)`; that is how `**kwargs` flows.
- Required positional parameters of *functions* stay positional:
  `push_frame(frame, direction=DOWNSTREAM)` → `pushFrame(frame, direction = FrameDirection.DOWNSTREAM)`.
  Keyword-only (`*,`) or optional groups of keyword args → a trailing options
  object: `push_error(msg, exception=e, category=c)` → `pushError(msg, { exception: e, category: c })`.
- Defaults: `None` → `null`. Use `?? default` (not `||`, which swallows `0`, `""` and `false`).
- Pydantic `BaseModel` params classes (`PipelineParams`, `InputParams`) →
  a class with an options constructor and defaults, so `new PipelineParams({ ... })`
  reads like Python. Use `zod` only where upstream validates *external*
  input (RTVI messages, config files).
- Python `@dataclass` → class with fields + options constructor.
  `field(default_factory=list)` → field initializer `= []`.

## Time and units

- Durations and timeouts stay in **seconds** (floats), as upstream does, so
  configs and docs carry over. Use `sleep(s)` from `@pipedog/asyncio`, never raw `setTimeout`.
- Clock values stay in **nanoseconds** as `number` (exact up to ~104 days of uptime).
- `bytes` → `Uint8Array` (never `Buffer`). PCM is 16-bit little-endian;
  read samples with `new Int16Array(u8.buffer, u8.byteOffset, u8.length / 2)`
  (copy first if `byteOffset` is odd).
- `time.time()` → `time()`; `time.monotonic()` → `monotonic()`; `time.monotonic_ns()` → `monotonicNs()`
  (all from `@pipedog/asyncio`).

## Async and cancellation (most important)

Python's `asyncio` semantics are kept by `@pipedog/asyncio`. Read its
`task.ts` header before porting anything with tasks.

| Python | TypeScript |
|---|---|
| `asyncio.create_task(coro())` | `createTask(() => coro())` (in a BaseObject: `this.createTask(() => this.x(), "name")`) |
| `await self.cancel_task(task)` | `await this.cancelTask(task)` |
| `asyncio.sleep(s)` | `sleep(s)` |
| `asyncio.Event / Queue / PriorityQueue / Lock / Semaphore` | same names from `@pipedog/asyncio` |
| `asyncio.wait_for(coro(), timeout=t)` | `waitFor(() => coro(), t)` (pass a function so it can be cancelled) |
| `asyncio.gather(a(), b())` | `gather(() => a(), () => b())` |
| `asyncio.TimeoutError` / `TimeoutError` | `TimeoutError` from `@pipedog/asyncio` |
| `asyncio.CancelledError` | `CancelledError` |
| `asyncio.current_task()` | `currentTask()` |
| `async with lock:` | `await lock.run(async () => { ... })` |
| `async for x in aiter` | `for await (const x of aiter)` |
| `async def gen(): yield` | `async function* gen()` |

**Rules:**

1. `except Exception:` does **not** catch `CancelledError` in Python, but
   `catch (e)` catches everything in JS. Every ported broad `catch` must start
   with `rethrowIfCancelled(e);`. Catching `CancelledError` deliberately
   (`except asyncio.CancelledError:`) → `if (e instanceof CancelledError) { ...; throw e; }`.
2. Cancellation is delivered at **cancellation points**: awaits on the
   primitives above, and on Tasks. A foreign await (fetch, an SDK, a
   WebSocket) is not one. Pass `currentSignal()` (or `task.signal`) to APIs
   that accept an `AbortSignal`, and/or wrap the await in `abortable(...)`.
3. Never `return` a Task (or any thenable) from an async function unless you mean to adopt it.
4. Never leave a promise floating. If upstream fire-and-forgets a task,
   use `this.createTask(...)` so it is tracked and cancelled at cleanup.
5. `loop.run_in_executor(None, fn)` (blocking work in a thread) → run it
   inline if cheap; otherwise an injectable async function. There are no threads on Workers.

## Classes and inheritance

- Abstract methods → `abstract` methods on an `abstract class`.
- `@property` → `get x()`; with a setter → `set x(v)`.
- `@staticmethod` / `@classmethod` → `static`.
- `isinstance(x, (A, B))` → `x instanceof A || x instanceof B`.
- `type(x).__name__` / `self.__class__.__name__` → `x.constructor.name`.
- `__str__` / `__repr__` → `toString()`.
- **Multiple inheritance:**
  - The second base is a mixin (no `__init__` state of its own, or a
    "Mixin"/protocol-like class) → a class-factory mixin with `defineMixin`
    from `utils/mixin.ts`: `class C(A, M)` → `class C extends M(A)`.
    `instanceof M` keeps working.
  - Both bases are concrete classes in the same hierarchy (e.g.
    `InputTextRawFrame(SystemFrame, TextFrame)`) → extend the first and
    `addVirtualBase(C, Second)`; copy the second's fields into `C`.
  - A mixin that is *also* used standalone gets both a mixin and a plain
    class: `export const WebsocketService = defineMixin(...)` plus
    `export abstract class WebsocketServiceBase extends WebsocketService(BaseObject)`.
- Overriding a method with a different signature (Python allows it) →
  keep the parent's signature, widen with an options object, or if impossible
  type the parent parameter as `unknown` with a comment (see `BaseObject.setup`).

## Enums

- Plain `Enum` → `as const` object + type of the same name:
  ```ts
  export const FrameDirection = { DOWNSTREAM: 1, UPSTREAM: 2 } as const;
  export type FrameDirection = (typeof FrameDirection)[keyof typeof FrameDirection];
  ```
  Use upstream's values (strings stay strings). `X.FOO.value` → `X.FOO`.
- An enum with methods or properties (`ErrorCategory.is_permanent`) → a class
  with static readonly instances, a `value` field, and the members as getters;
  add `static values()` and `static fromValue(v)`.
- `StrEnum` / `(str, Enum)` → `as const` object with string values.
- No TypeScript `enum` / `namespace` / parameter properties: the code must be
  erasable so Node can run sources directly (`erasableSyntaxOnly`).

## Frames

See the top of `frames/frames.ts`.

- `init=True` fields come from the options object; `init=False` fields are
  field initializers. Field order follows upstream.
- `__post_init__` logic → constructor body after `super()`; a subclass that
  only changes an `init=False` default → `override field = value`.
- Frames uninterruptible by default → `override interruptible = false`.
- `broadcast_frame(FrameCls, **kwargs)` → `broadcastFrame(FrameCls, options)`.
- Frame constructors always take a single options object, even when upstream
  tests pass positional args: `TextFrame("hi")` → `new TextFrame({ text: "hi" })`.

## Logging, warnings, deprecations

- `from loguru import logger` → `import { logger } from "<rel>/utils/logger.ts"`.
  Same level methods (`trace`, `debug`, `info`, `warning`, `error`, `critical`).
  `logger.exception(msg)` → `logger.error(msg, e)`.
- **Deprecated upstream APIs are not ported.** Anything marked `@deprecated`,
  `warn_deprecated`, "will be removed in 2.0.0", deprecated aliases (e.g.
  `PipelineTask`, `PipelineRunner`), deprecated parameters (e.g.
  `push_error(fatal=)`) and deprecated fields are left out. If non-deprecated
  code still *depends* on one internally, keep the internal piece and note it.
  Record what you dropped in the module's manifest `notes`.
- Tests that only exercise deprecated behavior are skipped, with
  `test.skip("…", …)` and a comment saying why.

## Dependencies

- Core takes no runtime dependencies beyond `@pipedog/asyncio` (and `zod`
  if needed). No `node:*` imports in core except `node:async_hooks` (in asyncio).
- Python SDK → the provider's official JS SDK if it is edge-compatible (uses
  `fetch`/`WebSocket`), else talk to the HTTP/WebSocket API directly with `fetch`
  and the global `WebSocket`. Keep a provider client behind a small interface
  so it can be swapped.
- Native/ML deps (Silero, Krisp, Koala, soxr, onnx models) live in their own
  packages, take the model as an external file/URL, and accept an injected
  runtime (`onnxruntime-node` on Bun/Node, `onnxruntime-web` WASM on Workers).
  Pure-algorithm fallbacks (e.g. a linear resampler) may live in core.
- `numpy` on PCM → typed arrays (`Int16Array`, `Float32Array`).

## WASM and Cloudflare Workers

- workerd refuses to compile WebAssembly from bytes at runtime (`WebAssembly.compile(buffer)`); a
  `.wasm` file must be imported as a module. So every package with WASM ships two entries selected
  by `package.json` export conditions:
  ```json
  "exports": { ".": { "workerd": "./src/entry.workerd.ts", "default": "./src/entry.ts" } }
  ```
  `entry.workerd.ts` does `import wasm from "../wasm/x.wasm"` and instantiates that Module;
  `entry.ts` loads the bytes (fetch of `new URL(..., import.meta.url)`, or `node:fs` as a fallback
  in that entry only). Both also accept an explicit `WebAssembly.Module | BufferSource` so apps can
  supply their own.
- Models (Silero, Smart Turn) are never bundled: they are loaded from a path/URL given by the
  user, with the upstream file name as the default. On Workers they come from R2, KV, static
  assets, or a `fetch`.
- No threads: upstream `ThreadPoolExecutor` / `run_in_executor` work runs inline (async) or in an
  injected runner. Keep per-call CPU low; Workers have CPU-time limits.
- WebRTC is unavailable on Workers; WebSocket-based transports must work there.
- `runtimes` in package.json is written by `bun run compat --write` from real runs on
  bun, node, deno and workerd. Never edit it by hand.

## Docstrings

Keep upstream docstrings as JSDoc (`/** ... */`), trimmed of Sphinx markup:
`:class:\`X\`` → `X`, `Args:` → `@param`, `Returns:` → `@returns`,
code examples → `@example` in TypeScript. Keep the *why* comments inside
methods; they carry design intent.

## Tests

- Port upstream tests 1:1 with `bun:test`: `class TestX(unittest.IsolatedAsyncioTestCase)` →
  `describe("TestX", ...)`; `async def test_y(self)` → `test("test_y", async () => ...)`.
  Keep test names so the two suites can be diffed.
- `self.assertEqual(a, b)` → `expect(a).toEqual(b)`; `assertIsInstance` →
  `expect(x).toBeInstanceOf(C)`; `with self.assertRaises(E)` → `expect(...).toThrow(E)` / `rejects`.
- `run_test(...)` → `runTest(...)` from `@pipedog/core/tests/utils`.
- `unittest.mock` / `AsyncMock` → `mock()` / `spyOn()` from `bun:test`.
- Tests that need a real network or API keys are skipped by default, as upstream does.
- A test that cannot pass yet because a dependency is unported →
  `test.todo` with the missing module in the message. Never weaken an
  assertion to make a test pass; if behavior must differ, `test.skip` with
  a `// DIVERGENCE:` comment and list it in the manifest.
