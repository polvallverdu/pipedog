# @pipedog/onnx

A tiny ONNX inference backend for pipedog's local models (`@pipedog/audio-silero`,
`@pipedog/audio-smart-turn`, and the local speech models: `@pipedog/kokoro`, `@pipedog/piper`,
`@pipedog/moonshine`, `@pipedog/whisper`, `@pipedog/funasr`). It wraps whichever ONNX runtime is available behind one small
interface, so the models never depend on a particular runtime and you can pass your own.

```ts
import { createOnnxBackend, float32Tensor, int64Tensor } from "@pipedog/onnx";

const backend = await createOnnxBackend(); // onnxruntime-node if installed, else onnxruntime-web
const session = await backend.createSession(modelBytesOrPathOrUrl, { forceCpu: true });
const out = await session.run({ x: float32Tensor(new Float32Array(512), [1, 512]) });
await session.dispose();
```

## Install a runtime

Both runtimes are **optional peer dependencies**: importing this package never needs them,
creating a backend needs one.

| runtime | install | notes |
|---|---|---|
| `onnxruntime-node` (native) | `bun add onnxruntime-node` / `npm i onnxruntime-node` | Fastest. ~300 MB unpacked (it ships binaries for every platform), which is why it is never installed for you. Works on Bun, Node ≥ 22 and Deno 2. |
| `onnxruntime-web` (WASM) | `bun add onnxruntime-web@1.30.0` | Single-threaded WebAssembly. No native code; works on Bun, Node, Deno and Cloudflare Workers. Pinned to the exact version the Workers integration is tested with. |

`createOnnxBackend()` tries `onnxruntime-node`, then `onnxruntime-web`, logs which one it picked,
and shares the result with every later caller. `createOnnxBackend({ prefer: "web" })`,
`createNativeBackend()` and `createWebBackend()` choose explicitly; the last two also take an
already imported module (`{ ort }`), e.g. for a bundler that must see the import.

Both packages are imported with a computed specifier, so bundlers leave them alone and they are
loaded from `node_modules` at runtime.

## The interface

```ts
interface OnnxBackend {
  readonly name: string;
  createSession(model: Uint8Array | ArrayBuffer | string | URL, options?: OnnxSessionOptions): Promise<OnnxSession>;
}
interface OnnxSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, OnnxTensor>>; // float32 / int64 / int32 / bool tensors
  dispose(): Promise<void>;
}
```

Models are bytes, a filesystem path, a `file:` URL (read with `node:fs`) or an `http(s):` URL
(fetched). Anything implementing `OnnxBackend` can be passed to the model packages as `backend`.

`sharedSession(backend, model, options)` returns one session per backend, model and options for the
whole process, so stateless models load once however many pipelines use them.

## Downloaded models

Models too large to ship in a package are downloaded on first use and cached:

```ts
import { downloadModelFile, modelCacheDir } from "@pipedog/onnx";

const dir = await modelCacheDir("kokoro"); // $PIPEDOG_CACHE_DIR/kokoro, $XDG_CACHE_HOME/pipedog/kokoro or ~/.cache/pipedog/kokoro
const path = await downloadModelFile("https://…/model.onnx", `${dir}/model.onnx`);
```

`downloadModelFile` skips files that already exist, writes to `<dest>.part` and renames when complete,
and shares one download between concurrent callers. It needs a filesystem (Bun, Node, Deno).

## Cloudflare Workers

The `"workerd"` export condition selects `src/index.workerd.ts`, where every backend is
onnxruntime-web set up for workerd, which refuses to compile WebAssembly from bytes:

1. `env.wasm.numThreads = 1` (no threads on Workers);
2. `env.wasm.wasmBinary` is set to a placeholder, so onnxruntime-web skips fetching its `.wasm`;
3. during the first `InferenceSession.create`, `WebAssembly.instantiate` is replaced by a
   function that instantiates `onnxruntime-web/ort-wasm-simd-threaded.wasm` **imported as a
   module** (wrangler compiles `.wasm` imports ahead of time), and restored afterwards.

This depends on onnxruntime-web internals, hence the exact version pin and the workerd smoke
test (`compat/smoke.ts`, run by `bun run compat`). There is no filesystem on Workers: pass model
bytes (R2, KV, static assets, `fetch`) or an `https:` URL. Bundle size: onnxruntime-web alone is
about 3.7 MB gzipped (a 14 MB `.wasm` plus ~30 KB of JS), over the 3 MB limit of the Workers
free plan, so it needs a paid plan (10 MB). Models are never bundled.

## Benchmarks

<!-- bench:start -->
| runtime | backend | Silero ms / 32 ms chunk | Smart Turn ms / inference | Smart Turn ms / prediction |
|---|---|---:|---:|---:|
| bun 1.4.2 | onnxruntime-node | 0.082 | 38.0 | 100.3 |
| bun 1.4.2 | onnxruntime-web | 0.277 | 174.3 | 229.7 |
| node 24.14.0 | onnxruntime-node | 0.209 | 42.1 | 128.3 |
| node 24.14.0 | onnxruntime-web | 0.201 | 175.5 | 254.7 |
| deno 2.9.5 | onnxruntime-node | 0.142 | 37.8 | 107.8 |
| deno 2.9.5 | onnxruntime-web | 0.215 | 177.6 | 247.0 |
| workerd 1.20261005.1 | onnxruntime-web (workerd) | 0.235 | 180.3 | 267.3 |

Measured 2026-10-20 on Apple M4 Pro, one thread, by `bun run bench`.
Silero: one 512-sample window at 16 kHz through `SileroOnnxModel`. Smart Turn: the model on
8 s of features (inference), and `_predictEndpoint` on 8 s of 16 kHz audio (log-mel features +
inference). Medians of batch means.
<!-- bench:end -->

## License

BSD 2-Clause. onnxruntime (MIT, Microsoft) is a peer dependency, not redistributed here.
