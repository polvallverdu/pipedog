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

Python's `asyncio` semantics are kept by `@pipedog/asyncio`, scheduling included. Read the
headers of its `loop.ts` and `task.ts` before porting anything with tasks.

| Python | TypeScript |
|---|---|
| `asyncio.create_task(coro())` | `createTask(() => coro())` (in a BaseObject: `this.createTask(() => this.x(), "name")`) |
| `await self.cancel_task(task)` | `await this.cancelTask(task)` |
| `asyncio.sleep(s)` | `sleep(s)` |
| `asyncio.Event / Queue / PriorityQueue / Lock / Semaphore` | same names from `@pipedog/asyncio` |
| `asyncio.wait_for(coro(), timeout=t)` | `waitFor(() => coro(), t)` (the function runs in the current task, as in Python 3.12+) |
| `asyncio.timeout(t)` | `await timeout(t, async () => { ... })` |
| `asyncio.gather(a(), b())` | `gather(() => a(), () => b())` |
| `asyncio.TimeoutError` / `TimeoutError` | `TimeoutError` from `@pipedog/asyncio` |
| `asyncio.CancelledError` | `CancelledError` |
| `asyncio.current_task()` | `currentTask()` |
| `loop.create_future()` / `fut.set_result(x)` | `new Future()` / `fut.setResult(x)` |
| `loop.call_soon(cb)` / `loop.call_later(s, cb)` | `callSoon(cb)` / `callLater(s, cb)` |
| `async with lock:` | `await lock.run(async () => { ... })` |
| `async for x in aiter` | `for await (const x of aiter)` |
| `async def gen(): yield` | `async function* gen()` |

**Rules:**

1. `except Exception:` does **not** catch `CancelledError` in Python, but
   `catch (e)` catches everything in JS. Every ported broad `catch` must start
   with `rethrowIfCancelled(e);`. Catching `CancelledError` deliberately
   (`except asyncio.CancelledError:`) → `if (e instanceof CancelledError) { ... }`, doing
   exactly what upstream does there: re-raise if it re-raises, and swallow it if upstream
   swallows it (`except asyncio.CancelledError: pass` ends the task normally, as in Python).
2. Cancellation is delivered at **cancellation points**: awaits on the
   primitives above, and on Tasks. A foreign await (fetch, an SDK, a
   WebSocket) is not one. Pass `currentSignal()` (or `task.signal`) to APIs
   that accept an `AbortSignal`, and/or wrap the await in `abortable(...)`.
3. Never `return` a Task (or any thenable) from an async function unless you mean to adopt it.
4. Never leave a promise floating. If upstream fire-and-forgets a task,
   use `this.createTask(...)` so it is tracked and cancelled at cleanup.
5. `loop.run_in_executor(None, fn)` (blocking work in a thread) → run it
   inline if cheap; otherwise an injectable async function. There are no threads on Workers.
6. Scheduling is asyncio's, so ported code interleaves exactly as upstream. A task runs until it
   awaits something that is not done; waking a waiter (a future's result, `Event.set()`,
   `Queue.put()`, a task finishing, a timer) only queues its wakeup, and queued wakeups run one at
   a time, in order, each once the microtask queue is empty. So the fast paths (`get()` on a
   non-empty queue, `put()` on an unbounded one, `wait()` on a set event, awaiting a done task or
   a coroutine that never suspends) do not let any other task run, and `sleep(0)` yields exactly
   one turn. Hand values between tasks with these primitives (or a `Future`), not with a raw
   `new Promise` resolver: a raw promise resumes its awaiter on the next microtask, mid-step of
   whoever resolved it, which asyncio never does.

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
  packages, accept the model as bytes/path/URL, and run ONNX through an
  `@pipedog/onnx` backend (`onnxruntime-node` or `onnxruntime-web`, optional
  peer dependencies; users can pass their own backend). Pure-algorithm
  fallbacks (e.g. a linear resampler) may live in core.
- `numpy` on PCM → typed arrays (`Int16Array`, `Float32Array`).
- `num2words` → [`num2words-ts`](https://www.npmjs.com/package/num2words-ts) (our exact port of it,
  LGPL as a dependency, like upstream's). `num2words(n, lang="en")` → `num2words(n, { lang: "en" })`.
  Python ints → `bigint` (or integer `number`); Python floats with an integral value (`1.0`) →
  `asFloat(1)` from `num2words-ts`, because num2words treats ints and floats differently.
- `sentencex` → `@pipedog/sentencex-wasm` (already wired into `utils/string.ts`).
- `soxr` → `@pipedog/resampler-wasm` (rubato, behind `audio/resamplers/soxr_*.ts`). Its presets
  carry libsoxr's names but are not bit-identical to libsoxr.
- `PyYAML` → [`yaml`](https://www.npmjs.com/package/yaml), only through `utils/yaml.ts`, which
  rebuilds PyYAML's `SafeLoader` (YAML 1.1 resolvers, per-class constructors) on its parser.
- `Pillow` JPEG encoding → `utils/jpeg_encoder.ts` (baseline, no dependencies).
- `json.dumps` / `json.loads` → `pyJsonDumps` / `pyJsonLoads` from `@pipedog/core/utils/py_json`
  (Python separators, `ensure_ascii`, float repr, NaN/Infinity). Never `JSON.stringify` where the
  output reaches a wire, a log line a test compares, or an LLM context. `base64.b64encode/decode`
  → `bytesToBase64` / `base64ToBytes` from `@pipedog/core/utils/base64`. Don't write local copies.
- New third-party dependencies: pin dev dependencies exactly, to a version published at least 14
  days ago (`npm view <pkg> time`); the published range is `^<that version>`. Check the version
  you pinned actually resolves in `bun.lock`.
- Filesystem access (`aiofiles`, `pathlib`) → an injected reader or `fs` object
  (`node:fs/promises` satisfies `LocalFileSystem`); core never imports `node:fs`.

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
- Models (Silero, Smart Turn) ship in their package's `data/` (the upstream file, and the
  default on Bun, Node and Deno), but are never bundled into a Worker: on Workers the user passes
  their bytes (from R2, KV, static assets, or a `fetch`).
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


## Providers and transports

Services and transports are where runtimes differ. Keep the upstream class and its behavior;
choose the client so it runs on as many of Bun, Node, Deno and Workers as the provider allows,
and declare honestly where it doesn't.

- **Client choice, in order:** the provider's official JS SDK if it works over `fetch` /
  `WebSocket` (e.g. `@google/genai`, `@langchain/core`); otherwise call the provider's REST or
  WebSocket API directly with `fetch` / the global `WebSocket`; only when the provider offers
  nothing but gRPC streaming (e.g. Google Cloud Speech streaming, Cloud TTS
  `streaming_synthesize`), use its Node SDK (`@google-cloud/speech`, `@google-cloud/text-to-speech`).
  SDKs are dependencies of the provider package; heavy or runtime-limited ones are optional peers.
- **Per-class runtimes:** when one package mixes portable and Node-only services, keep the
  Node-only SDK out of the portable classes' import graph (lazy `import()` inside the class, or a
  separate subpath), so importing the package and using a portable class works on Workers. Say
  per class in the README which runtimes work, and make `compat/smoke.ts` exercise every class
  on every runtime it claims (with a fake server where a real API key would be needed).
- **No real network in tests.** Port upstream's tests with their mocks; for SDK calls, inject a
  fake client or point the client at a local fake server (`Bun.serve`). Tests that need real API
  keys are skipped by default, as upstream does.
- **Audio codecs:** μ-law / A-law and PCM conversions live in core (`audio/utils`). Opus or other
  codecs come from a WASM package, never a native addon, unless the transport itself is native.
- **WebSocket transports:** upstream's server (the `websockets` package), client, and FastAPI
  transports become runtime-agnostic transports over a minimal socket interface (`send`, `close`,
  message/close events), plus thin adapters for each runtime's server: `Bun.serve` websockets,
  Node `ws`, `Deno.serve` upgrade, Cloudflare `WebSocketPair` (and Hono, which runs on all of
  them). The FastAPI transport's role (a socket accepted by the app's own web framework) maps to
  "bring your own socket". The client uses the global `WebSocket`.
- **Serializers** (Telnyx, Twilio, protobuf, RTVI) are pure and must run everywhere. Their wire
  format is the protocol: byte-for-byte identical to upstream. Protobuf uses the same
  `frames.proto` as upstream with a pure-JS protobuf library.
