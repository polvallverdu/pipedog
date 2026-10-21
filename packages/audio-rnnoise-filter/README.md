# @pipedog/audio-rnnoise-filter

[RNNoise](https://gitlab.xiph.org/xiph/rnnoise) noise suppression for pipedog: a port of Pipecat's
`pipecat.audio.filters.rnnoise_filter` (`RNNoiseFilter`). Upstream calls the native `pyrnnoise`
library. Here RNNoise runs as WebAssembly (RNNoise 0.2, built by
[`@jitsi/rnnoise-wasm`](https://github.com/jitsi/rnnoise-wasm), Apache-2.0, 1.4 MB), so the
filter works on every runtime, Cloudflare Workers included, with no native code.

```ts
import { RNNoiseFilter } from "@pipedog/audio-rnnoise-filter";

const transportParams = new TransportParams({
  audioInEnabled: true,
  audioInFilter: new RNNoiseFilter(),
});
```

## Runtimes

| | Bun | Node ≥ 22 | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `RNNoiseFilter` | ✅ | ✅ | ✅ | ✅ |

Needs: nothing to install; the module ships in `wasm/rnnoise.wasm`. On Workers the package's
`"workerd"` export condition imports the `.wasm` as a pre-compiled module (workerd refuses to
compile WebAssembly from bytes), so wrangler or your bundler must treat `.wasm` as a module
(the default rule). Per call the filter costs well under a millisecond per 10 ms frame.

## How it works

RNNoise always runs at 48 kHz on 480-sample (10 ms) frames. The filter buffers incoming audio into
frames. When the transport's rate is not 48 kHz, it resamples in and out with core's
`SOXRStreamAudioResampler` (`@pipedog/resampler-wasm`), at quality `"QQ"` by default. A call
returns the frames that completed, so the first calls can be empty and the output lags the input
by under one frame, as upstream.

```ts
new RNNoiseFilter({ resamplerQuality: "HQ" }); // "VHQ" | "HQ" | "MQ" | "LQ" | "QQ" (default)
```

`FilterEnableFrame` switches the filter on and off. If RNNoise cannot be loaded, `start()` logs
the error and `filter()` passes audio through, as upstream does when pyrnnoise is missing.

## Options

| option | default | |
|---|---|---|
| `resamplerQuality` | `"QQ"` | resampler preset when the transport is not at 48 kHz |
| `rnnoise` | the bundled WASM build | a factory `({ sampleRate }) => RNNoiseLike`, to supply your own denoiser |

Lower level: `initRnnoise(source?)` loads the module (bytes, a `WebAssembly.Module`, a URL or a
`Response`; on workerd only a module), `RNNoise` mirrors pyrnnoise's `denoise_chunk`, and
`RnnoiseEngine.createState()` gives the raw 480-sample `processFrame`.

## Differences from upstream

- DIVERGENCE: `pyrnnoise` (native) is replaced by the WebAssembly build above. The model is
  RNNoise's, so the output is the same kind of denoising, but it is not tested bit for bit.
- The upstream tests patch the module-level `RNNoise` and resampler classes. Here the `rnnoise`
  option and a protected `_createResampler()` hook stand in.

`bun run extract:wasm` regenerates `wasm/rnnoise.wasm` from the pinned `@jitsi/rnnoise-wasm`
dev dependency (`--check` compares).

## License

BSD 2-Clause. The WebAssembly module is RNNoise (BSD 3-Clause, Xiph.Org, Mozilla and others) as
compiled by `@jitsi/rnnoise-wasm` (Apache-2.0); see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
