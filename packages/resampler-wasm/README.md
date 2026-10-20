# @pipecat-ts/resampler-wasm

High-quality PCM sample-rate conversion for pipecat-ts, compiled to WebAssembly.
It is the engine behind core's `SOXRAudioResampler` and `SOXRStreamAudioResampler`.

- [rubato](https://github.com/HEnquist/rubato) 5.0.1 (MIT OR Apache-2.0) windowed-sinc resampler, written in Rust,
  built for `wasm32-unknown-unknown`. We use it instead of libsoxr, which is LGPL and needs emscripten.
- No wasm-bindgen and no generated JS glue. The module has **zero imports** and a small C ABI
  (`rust/src/lib.rs`), and `src/engine.ts` wraps the `WebAssembly.Instance` exports by hand.
- `wasm/resampler.wasm` is a committed build artifact of **39,790 bytes** (27.6 KB gzipped).
  It is built with cargo `opt-level = "z"`, LTO, `panic = "abort"`, then `wasm-opt -Oz`.
- int16 little-endian PCM in and out, plus float32. Any channel count from 1 to 8, interleaved.
- One-shot and streaming. Streams take chunks of any size, keep the audio continuous across
  chunks, and support `flush()` and `reset()`.
- Verified on Bun, Node 24, Deno 2 and workerd (Cloudflare Workers).

## Usage

```ts
import { initResampler } from "@pipecat-ts/resampler-wasm";

const engine = await initResampler(); // once; everything after this is synchronous

// One-shot (a whole clip, tail included). Returns the input unchanged if the rates are equal.
const out: Uint8Array = engine.resample(pcm16, 8000, 16000, { quality: "VHQ" });

// Streaming
const stream = engine.createStream(48000, 16000, { quality: "HQ", channels: 1 });
const a = stream.process(chunk1);   // any chunk size
const b = stream.process(chunk2);
const tail = stream.flush();        // emit the filter tail, then start a new stream
stream.reset();                     // or: drop the held audio
stream.destroy();                   // free the WASM-side state
```

There are also `resampleSamples(Int16Array)`, `resampleFloat32(Float32Array)`, and
`processSamples`/`processFloat32`/`flushSamples`/`flushFloat32` on streams.

## Loading on each runtime

`package.json` `"exports"["."]` uses export conditions:

| condition | entry | how the module gets loaded |
|---|---|---|
| `workerd` | `src/workerd.ts` | `import wasm from "../wasm/resampler.wasm"` gives a compiled `WebAssembly.Module` (wrangler's default `.wasm` rule), which is instantiated synchronously. workerd refuses to compile WASM from bytes ("Wasm code generation disallowed by embedder", confirmed by the smoke test). `getResampler()` works without calling `initResampler()` first. |
| `default` | `src/index.ts` | `fetch(new URL("../wasm/resampler.wasm", import.meta.url))`. Bun and Deno can fetch `file:` URLs. Node 24 cannot ("not implemented... yet"), so the entry falls back to a dynamic `import("node:fs/promises")`. The specifier is held in a variable so bundlers and type checkers ignore it. |

`initResampler(source?)` accepts a `WebAssembly.Module`, a `BufferSource`, a `URL` or a `Response`
(the last two only on the default entry). With no argument it loads the bundled file. It is
idempotent, and concurrent callers share a single load. `getResampler()` returns the shared
engine. On the default entry it throws if `initResampler()` has not been awaited yet.
`./engine` exports `engineFromModule`/`engineFromSource` for anyone who wants to manage
instances themselves.

## Quality presets

The preset names are libsoxr's. Each one maps to rubato `SincInterpolationParameters`, and the
filter length increases from one preset to the next.

| preset | `sinc_len` | window | `oversampling_factor` | interpolation | `f_cutoff` (auto) | delay (input frames) |
|---|---|---|---|---|---|---|
| `QQ`  | 16  | Hann2           | 32  | Linear    | 0.668 | 8   |
| `LQ`  | 32  | Blackman2       | 64  | Linear    | 0.704 | 16  |
| `MQ`  | 64  | Blackman2       | 128 | Quadratic | 0.852 | 32  |
| `HQ`  | 128 | BlackmanHarris2 | 256 | Cubic     | 0.895 | 64  |
| `VHQ` | 256 | BlackmanHarris2 | 256 | Cubic     | 0.947 | 128 |

- `f_cutoff` is left at `None`, so rubato's `calculate_cutoff` chooses it: the highest cutoff
  that keeps aliasing below the window's sidelobe level for that filter length. The table shows
  the cutoff relative to the lower of the two Nyquist frequencies. When downsampling, rubato
  scales it by the ratio. For example, VHQ from 48 kHz to 16 kHz gives 0.316 of the input
  Nyquist, which is 0.947 of the output Nyquist.
- Delay is the filter's look-ahead, equal to `sinc_len / 2` input frames (8 ms for VHQ at 16 kHz).
  It is compensated: the output is time-aligned with the input to within about 0.01 sample
  (see "Alignment"). In streaming mode it still shows up as latency, because the last
  `sinc_len / 2` input frames only come out on the next chunk or on `flush()`.
- Memory: each stream holds a sinc table of `sinc_len × oversampling` floats, which is 256 KB
  for VHQ, 128 KB for HQ and about 2 KB for QQ. WASM memory grows and never shrinks.
- Speed (Bun, Apple Silicon, mono): converting 10 s of 16 kHz audio to 48 kHz takes 100 ms at
  VHQ, 56 ms at HQ and 12 ms at QQ. Converting 10 s from 44.1 kHz to 16 kHz takes 39 ms at VHQ.
  A `simd128` build was measured and gave no speed-up, so the artifact is plain scalar wasm.

## Streaming semantics

- Each `process()` call is split into pieces of at most 1024 frames.
  `Resizable::set_chunk_size` is set to each piece's length, which keeps the filter history.
  Nothing is held back beyond the filter delay. A sample count that is not a multiple of the
  channel count leaves the remainder buffered for the next call.
- Output is aligned: the start-up delay is trimmed from the front of every stream. `flush()`
  pads with silence until the stream has emitted exactly `round(totalInputFrames × out / in)`
  frames, then resets. This matches upstream's
  `test_soxr_stream_audio_resampler_flush_returns_the_held_audio`: 640 samples at 16 kHz give
  fewer than 320 samples, and adding the flush gives exactly 320.
- `reset()` discards the filter history, any pending samples and the counters.
- **Alignment.** rubato's first output frame sits at input position `1/ratio − sinc_len/2`, so
  the raw delay is `sinc_len·ratio/2 − 1` output frames. For many ratios that is a fraction
  (48 kHz → 16 kHz, for example). To make it a whole number, the stream is primed with
  `k` zero frames, where `k < 2q` and `q` is the denominator of the reduced ratio `p/q`. The
  whole-number delay is then trimmed. All of this is computed in `alignment()` in
  `rust/src/lib.rs`.
- Output samples differ from libsoxr's because the filters are different. Lengths follow the
  rule above.

## What core needs to call

Core must stay dependency-free, so it should declare this structural interface itself and
accept an injected engine. `createSoxrCompatibleEngine(engine)` returns exactly this shape:

```ts
type SoxrQuality = "QQ" | "LQ" | "MQ" | "HQ" | "VHQ";
interface SoxrCompatibleEngine {
  // stands in for soxr.resample(audio, in_rate, out_rate, quality=...)
  resample<T extends Int16Array | Float32Array>(audio: T, inRate: number, outRate: number, quality: SoxrQuality): T;
  // stands in for soxr.ResampleStream(in_rate=, out_rate=, num_channels=, quality=, dtype="int16")
  createStream(o: { inRate: number; outRate: number; numChannels: number; quality: SoxrQuality }): {
    resampleChunk<T extends Int16Array | Float32Array>(chunk: T, last?: boolean): T; // last=true appends the tail and resets
    clear(): void;   // soxr ResampleStream.clear()
    destroy(): void; // free WASM state (optional; a FinalizationRegistry is the backstop)
  };
}
```

Mapping onto `packages/core/src/audio/resamplers/`:

| core stub | delegate to |
|---|---|
| `soxrResample(audio, inRate, outRate, quality)` (`soxr_resampler.ts`; also used with `Float32Array` by `local_smart_turn_v3.ts`) | `engine.resample(audio, inRate, outRate, quality)` |
| `new SoxrResampleStream({ inRate, outRate, numChannels, quality })` (`soxr_stream_resampler.ts`) | `engine.createStream({ inRate, outRate, numChannels, quality })` |
| `SoxrResampleStream.resampleChunk(chunk, last)` | `stream.resampleChunk(chunk, last)` |
| `SoxrResampleStream.clear()` | `stream.clear()` |

Suggested wiring: core adds a setter, for example `setSoxrEngine(e: SoxrCompatibleEngine)`
next to the stubs, and the stubs throw a clear "call setSoxrEngine()" error while it is unset.
The application then does:

```ts
import { createSoxrCompatibleEngine, initResampler } from "@pipecat-ts/resampler-wasm";
import { setSoxrEngine } from "@pipecat-ts/core/audio/resamplers/soxr_resampler";

setSoxrEngine(createSoxrCompatibleEngine(await initResampler()));
```

On Workers, `getResampler()` is synchronous, so the setter can also be called with
`setSoxrEngine(createSoxrCompatibleEngine(getResampler()))`. The smoke test checks this inside
a request handler. It has not been checked at module top level.

Equal rates never reach the engine, because core returns early just as upstream does. The
engine's `resample` also returns its input unchanged for equal rates.

## C ABI (for reference)

| export | |
|---|---|
| `rs_alloc(len) -> ptr`, `rs_free(ptr, len)` | raw linear-memory blocks |
| `rs_stream_new(in_rate, out_rate, channels, quality) -> handle` | quality: 0=QQ … 4=VHQ; 0 on bad params |
| `rs_stream_input(h, n) -> *i16` / `rs_stream_input_f32(h, n) -> *f32` | staging buffer for `n` samples |
| `rs_stream_process(h, n) -> count` / `rs_stream_process_f32` | output at `rs_stream_output(h)` / `rs_stream_output_f32(h)`; −1 on error |
| `rs_stream_flush(h) -> count` / `rs_stream_flush_f32` | drain tail and reset |
| `rs_stream_reset(h)`, `rs_stream_free(h)` | |
| `rs_stream_delay(h)`, `rs_stream_cutoff(h)`, `rs_quality_sinc_len(q)`, `rs_quality_oversampling(q)` | introspection |

The JS side copies its input into the staging buffer and copies the output out. It recreates
typed-array views after every call, because a `memory.grow` detaches the old `ArrayBuffer`.

## Building and testing

```sh
rustup target add wasm32-unknown-unknown
bun run build:wasm      # cargo + wasm-opt -Oz (wasm-opt from PATH, else `npx -p binaryen`); --no-opt to skip
bun test                # bun:test suite (test/resampler.test.ts)
bun run smoke:node      # node test/smoke/node.ts (TypeScript sources run directly; Node >= 22.6)
bun run smoke:deno      # deno run -A test/smoke/deno.ts
bun run smoke:workerd   # bundles test/smoke/workerd/worker.ts with the "workerd" condition, serves it with `npx workerd`
```
