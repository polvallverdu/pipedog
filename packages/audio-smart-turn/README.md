# @pipedog/audio-smart-turn

Local [Smart Turn v3](https://github.com/pipecat-ai/smart-turn) end-of-turn detection for pipedog.
The analyzer itself, `LocalSmartTurnAnalyzerV3`, is ported in `@pipedog/core` (core has no ONNX
runtime, so it takes an injected session factory). This package wires it to
[`@pipedog/onnx`](../onnx) and ships the model upstream ships, `smart-turn-v3.2-cpu.onnx`, in `data/`.

```ts
import { createLocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";

const turnAnalyzer = createLocalSmartTurnAnalyzerV3(); // same options as core's analyzer
```

Install an ONNX runtime: `onnxruntime-node` (fastest) or `onnxruntime-web@1.30.0`.

## Options

Everything `LocalSmartTurnAnalyzerV3Options` takes (`sampleRate`, `params`, `cpuCount`,
`smartTurnModelPath`), except `createSession`, plus:

| option | default | |
|---|---|---|
| `model` | `smartTurnModelPath` if set, else the bundled `data/smart-turn-v3.2-cpu.onnx` (Bun, Node, Deno) | bytes, a path, a `file:` or `https:` URL |
| `backend` | `createOnnxBackend()` | any `OnnxBackend` |

`onnxSmartTurnSessionFactory({ model?, backend? })` returns just the `createSession` function, to
construct core's `LocalSmartTurnAnalyzerV3` (or a subclass) yourself.

## Cloudflare Workers

Pass the model's bytes (R2, KV, static assets or `fetch`); there is no filesystem:

```ts
const model = await (await env.MODELS.get("smart-turn-v3.2-cpu.onnx"))!.bytes();
const turnAnalyzer = createLocalSmartTurnAnalyzerV3({ model });
```

The file is exported as `@pipedog/audio-smart-turn/smart-turn-v3.2-cpu.onnx`. One prediction
costs roughly 270 ms of CPU with onnxruntime-web (features + inference, see below), so it needs
a plan whose CPU-time limit allows it.

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

BSD 2-Clause. The model `data/smart-turn-v3.2-cpu.onnx` is Smart Turn v3.2 by Daily
(BSD 2-Clause; fine-tuned from `openai/whisper-tiny`, Apache-2.0); see
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
