# @pipedog/moonshine

Local speech-to-text with [Moonshine](https://github.com/moonshine-ai/moonshine) for pipedog: a
port of Pipecat's `MoonshineSTTService`. Moonshine is a small, fast ASR family that runs on the
CPU, with no GPU and no API key.

Upstream wraps the `moonshine_voice` Python package (a C++ core on ONNX Runtime). This package
runs the **same quantized `.ort` model files** from download.moonshine.ai through
[`@pipedog/onnx`](../onnx), with a TypeScript engine (`@pipedog/moonshine/moonshine_voice`)
that ports the part of Moonshine's C++ core that `transcribe_without_streaming` runs: the
catalog, the `tokenizer.bin` decoder, greedy decoding for the non-streaming (`tiny`, `base`)
and streaming (`*-streaming`) architectures with the same token budgets, and the Silero VAD
segmentation Moonshine applies to each batch.

```ts
import { Model, MoonshineSTTService, MoonshineSTTSettings } from "@pipedog/moonshine";
import { Language } from "@pipedog/core/transcriptions/language";

const stt = new MoonshineSTTService({
  settings: new MoonshineSTTSettings({ model: Model.SMALL_STREAMING, language: Language.EN }),
});
```

It is a `SegmentedSTTService`: put a VAD in front of it (it transcribes each speech segment) and
feed it 16 kHz 16-bit mono PCM, like upstream.

## Install

```sh
bun add @pipedog/moonshine onnxruntime-node
```

`onnxruntime-node` is an optional peer of `@pipedog/onnx`; `onnxruntime-web@1.30.0` (WASM) loads
the same `.ort` files and gives the same transcripts, about 3x slower.

## What you need

| | |
|---|---|
| models | Moonshine's quantized ORT-format models from `https://download.moonshine.ai/model/...`, the files and versions `moonshine_voice` 0.1.5 uses (each download is checked against Moonshine's published size and CRC32C) |
| sizes | English: `tiny` 44 MB, `tiny-streaming` 45 MB, `base` 141 MB, `small-streaming` 142 MB (default), `medium-streaming` 269 MB. Other languages: `tiny-streaming` 32 MB, `small-streaming` 122 MB, `base` 65-141 MB, `tiny` (ja, ko) 72 MB |
| download | automatic, once, on `start()` or the first transcription |
| cache | `$PIPEDOG_CACHE_DIR/moonshine`, else `$XDG_CACHE_HOME/pipedog/moonshine`, else `~/.cache/pipedog/moonshine`; or the `cacheRoot` option. Files go in `<cacheRoot>/download.moonshine.ai/model/<model>/...`, the layout `moonshine_voice` uses, so you can copy a `moonshine_voice` cache over |
| VAD | Silero VAD, the `silero_vad.onnx` shipped with `@pipedog/audio-silero` (a dependency; the same model Moonshine embeds, checked to give identical probabilities) |

Languages: Arabic, Chinese, English, German, Japanese, Korean, Spanish, Tagalog, Ukrainian and
Vietnamese; regional variants resolve to the base code. An architecture a language doesn't
publish falls back to that language's default (as upstream).

To use files you already have, pass `cacheRoot` (the directory holding
`download.moonshine.ai/...`), or use the engine directly with any model directory:

```ts
import { ModelArch, Transcriber } from "@pipedog/moonshine/moonshine_voice";

const transcriber = new Transcriber("/models/tiny-en", ModelArch.TINY);
const transcript = await transcriber.transcribeWithoutStreaming(float32Samples, 16000);
console.log(transcript.lines.map((line) => line.text).join(" "));
```

`downloadModel(language, arch?)` downloads a model ahead of time and returns `[path, arch]`.

## Options

`MoonshineSTTService` takes everything `SegmentedSTTService` does, plus:

| option | default | |
|---|---|---|
| `settings` | `model: "small-streaming"`, `language: Language.EN` | runtime-updatable; a change reloads the model (keeping the old one if the new one fails to load) |
| `cacheRoot` | see above | where models are downloaded (pipedog only) |
| `transcriberOptions` | | `Transcriber` options (pipedog only): `backend` (any `OnnxBackend`), `fetch` for downloads, `files` (model files in memory), `vadModel`, `shareSessions`, and Moonshine's `maxTokensPerSecond` (6.5), `vadThreshold` (0.5), `vadWindowDuration` (0.5 s), `vadHopSize` (512), `vadLookBehindSampleCount` (8192), `vadMaxSegmentDuration` (15 s) |

## Runtimes

| class | bun | node | deno | workerd |
|---|---|---|---|---|
| `MoonshineSTTService`, `Transcriber` | yes | yes | yes | no |

On Cloudflare Workers the models (32-269 MB) and their inference sessions don't fit the memory
and bundle limits. `Transcriber` accepts model files in memory (`files`), which with
onnxruntime-web also allows browsers.

Timings for the 11 s JFK clip (4 segments), Apple M4 Pro, Bun, onnxruntime-node: `tiny` 0.1 s,
`base` 0.12 s, `tiny-streaming` 0.2 s, `small-streaming` 0.35 s (onnxruntime-web: `tiny` 0.4 s,
`tiny-streaming` 0.55 s).

## Differences from upstream

- The model is resolved in the constructor but downloaded and loaded in `start()` (or on the
  first transcription); upstream downloads and loads it in the constructor. `getModelForLanguage`
  returns the cache path without downloading; the `Transcriber` downloads on first use.
- Upstream's `get_model_for_language` also prefetches the optional English spelling model, which
  `transcribe_without_streaming` never uses; it is not downloaded.
- Only what `transcribe_without_streaming` needs is ported: no streaming API (`create_stream`),
  word timestamps, speaker diarization, key-term biasing or spelling mode.
- Text decoding: Moonshine's C++ replaces malformed UTF-8 with `?` (ported); Python then drops
  any remaining invalid bytes, where `TextDecoder` would emit U+FFFD (not reachable with the
  published vocabularies).
- Inference runs on onnxruntime 1.30 (Moonshine bundles 1.23.2); the same graphs, so the same
  transcripts up to floating-point rounding.

## License

BSD 2-Clause. The engine ports parts of [Moonshine](https://github.com/moonshine-ai/moonshine)
(MIT). The models are downloaded at runtime, not shipped: they are MIT-licensed in every
language and size, except the non-streaming models (`tiny`, `base`) for languages other than
English, which are under the non-commercial
[Moonshine Community License](https://www.moonshine.ai/license). Silero VAD (via
`@pipedog/audio-silero`) is MIT.
