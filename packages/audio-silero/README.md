# @pipedog/audio-silero

[Silero VAD](https://github.com/snakers4/silero-vad) for pipedog: a port of Pipecat's
`pipecat.audio.vad.silero` (`SileroVADAnalyzer` and its `SileroOnnxModel` wrapper), with the same
model file upstream ships (`silero_vad.onnx`, 8 kHz and 16 kHz) included in `data/`.

```ts
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
// or "@pipedog/audio-silero/silero", the path of upstream's module

const vad = new SileroVADAnalyzer({ sampleRate: 16000 });
```

Use it wherever Pipecat takes a VAD analyzer (`VADProcessor`, `VADController`, user turn
strategies). Inference runs through [`@pipedog/onnx`](../onnx): install `onnxruntime-node`
(fastest) or `onnxruntime-web@1.30.0`.

## Options

| option | default | |
|---|---|---|
| `sampleRate` | set later | 8000 or 16000 |
| `params` | `new VADParams()` | thresholds and timing, as upstream |
| `model` | the bundled `data/silero_vad.onnx` (Bun, Node, Deno) | bytes, a path, a `file:` or `https:` URL |
| `backend` | `createOnnxBackend()` | any `OnnxBackend` |

The model loads asynchronously, starting in the constructor. `await vad.ready()` waits for it;
otherwise the first `analyzeAudio` does. A model that cannot be loaded rejects `analyzeAudio`
(upstream fails in the constructor). `cleanup()` releases the ONNX session.

Differences from upstream, all forced by JavaScript ONNX runtimes being asynchronous:
`voiceConfidence()` and the model call (`SileroOnnxModel.call`, upstream `__call__`) return
promises, and core's `VADAnalyzer` awaits them one buffer at a time (upstream runs them on a
single-thread executor). Audio chunks are `Float32Array` or `{ data, dims }` instead of numpy arrays.

## Cloudflare Workers

There is no filesystem, so pass the model's bytes, e.g. from R2 or static assets:

```ts
const model = await (await env.MODELS.get("silero_vad.onnx"))!.bytes();
const vad = new SileroVADAnalyzer({ sampleRate: 16000, model });
```

The file is exported as `@pipedog/audio-silero/silero_vad.onnx` for copying into your assets.
Do not bundle it into the Worker: with onnxruntime-web the Worker is already ~3.7 MB gzipped.

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

The code is BSD 2-Clause (a port of Pipecat, Copyright (c) 2024–2026 Daily). The model
`data/silero_vad.onnx` is Silero VAD, MIT License, Copyright (c) 2020-present Silero Team; see
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
