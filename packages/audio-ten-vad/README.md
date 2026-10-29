# @pipedog/audio-ten-vad

[TEN VAD](https://github.com/TEN-framework/ten-vad) for pipedog: `TenVADAnalyzer`, a VAD analyzer
that runs TEN VAD's WebAssembly build, as an opt-in alternative to
[Silero](../audio-silero). Use it wherever pipedog takes a VAD analyzer (the user aggregator's
`vadAnalyzer`, `VADProcessor`). This package is pipedog only: upstream Pipecat has no TEN VAD.

> [!WARNING]
> **TEN VAD has its own license, and this package contains none of TEN VAD.**
>
> TEN VAD is licensed under Apache-2.0 **with additional conditions** (among them a non-compete
> clause regarding Agora, and that derivative works of TEN VAD remain under TEN's license).
> pipedog is BSD-2-Clause, so `@pipedog/audio-ten-vad` ships no TEN code, JavaScript glue,
> WebAssembly, model or data, and is not derived from them: it only calls TEN's documented
> WebAssembly interface (`ten_vad_create`, `ten_vad_process`, `ten_vad_destroy`), described by
> pipedog's own TypeScript types. **You** obtain TEN's prebuilt files and pass them in at runtime,
> and TEN's conditions apply to your use and distribution of those files. Read
> [TEN VAD's license](https://github.com/TEN-framework/ten-vad/blob/main/LICENSE) before you ship,
> and consider a "Powered by ten-vad" notice in your app.

## Getting TEN's files

From [TEN's repository](https://github.com/TEN-framework/ten-vad), take the two files of its web
build:

- `lib/Web/ten_vad.js`: the Emscripten loader. Its default export is `createVADModule`.
- `lib/Web/ten_vad.wasm`: the WebAssembly binary (about 300 KB, model included).

Copy them into your app, for example as `ten-vad/`.

## Usage

`loadTenVadModule()` calls TEN's factory with the right Emscripten options. Load the module once
and pass it (or its promise) to every analyzer: each analyzer creates its own TEN VAD instance in
the shared module.

### Bun, Node, Deno

```ts
import { readFile } from "node:fs/promises";
import { loadTenVadModule, TenVADAnalyzer } from "@pipedog/audio-ten-vad";
import createVADModule from "./ten-vad/ten_vad.js";

const tenVad = loadTenVadModule({
  factory: createVADModule,
  wasmBinary: await readFile("./ten-vad/ten_vad.wasm"),
});

const vad = new TenVADAnalyzer({ module: tenVad, sampleRate: 16000 });
```

### Browsers

TEN's loader fetches `ten_vad.wasm` from next to `ten_vad.js` (or pass `wasmBinary`, or a
`locateFile` in `moduleOverrides`):

```ts
import createVADModule from "/ten-vad/ten_vad.js";

const vad = new TenVADAnalyzer({ module: loadTenVadModule({ factory: createVADModule }) });
```

### Cloudflare Workers

Workers can't compile WebAssembly from bytes. Import the `.wasm` as a module (Wrangler's default
rule for `.wasm` gives a `WebAssembly.Module`) and pass it as `wasmModule`; it is instantiated
through Emscripten's `instantiateWasm` hook:

```ts
import createVADModule from "./ten-vad/ten_vad.js";
import tenVadWasm from "./ten-vad/ten_vad.wasm";

const vad = new TenVADAnalyzer({
  module: loadTenVadModule({ factory: createVADModule, wasmModule: tenVadWasm }),
});
```

TEN builds `ten_vad.js` for browsers and web workers. Whether it loads on a given server runtime is
a property of TEN's build; pipedog's own tests and compat smoke test run the analyzer against a
stand-in module, since pipedog can't ship TEN's files. Set `TEN_VAD_DIR` to a directory holding
`ten_vad.js` and `ten_vad.wasm` to run the end-to-end test with yours:

```bash
TEN_VAD_DIR=/path/to/ten-vad/lib/Web bun test packages/audio-ten-vad
```

### 16 kHz only

TEN VAD takes 16 kHz mono 16-bit audio: the analyzer throws for any other sample rate. Run the
transport's input at 16 kHz (`audioInSampleRate: 16000`) or resample first.

## Options

| option | default | |
|---|---|---|
| `module` | required | TEN VAD's module, or a promise of it, from `loadTenVadModule()` |
| `hopSize` | `256` | samples per frame: `256` (16 ms) or `160` (10 ms), the sizes TEN VAD is optimized for |
| `threshold` | `0.5` | TEN's own speech-flag threshold (see below) |
| `sampleRate` | set later | must be 16000 |
| `params` | `new VADParams()` | confidence, start/stop times and volume gate, as for every VAD analyzer |

The confidence the analyzer reports is TEN's speech **probability**. Whether a frame counts as
speech is decided by `params.confidence` (and `minVolume`), exactly as with Silero; `threshold`
only sets the flag TEN computes alongside the probability, which the analyzer doesn't use.

The TEN VAD instance is created once `module` resolves: `await vad.ready()` waits for it,
otherwise the first `analyzeAudio` does. From then on each frame is scored synchronously. A
non-zero return from TEN throws. `cleanup()` destroys the instance and frees its memory.

## TEN VAD or Silero

| | TEN VAD | Silero |
|---|---|---|
| license of the model and runtime | Apache-2.0 with TEN's additional conditions | MIT |
| files | you obtain TEN's `.js` + `.wasm` (~300 KB) | model bundled with `@pipedog/audio-silero` |
| runtime | WebAssembly | ONNX Runtime |
| sample rates | 16 kHz | 8 and 16 kHz |
| frame | 10 or 16 ms | 32 ms |

TEN reports a lower per-frame cost and quicker speech-end detection than Silero in its own
benchmarks. Which one detects your users' speech better depends on the audio (line quality, noise,
languages): evaluate both on your own recordings before switching.
