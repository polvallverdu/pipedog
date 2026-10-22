# @pipedog/funasr

Local speech-to-text with [SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)
for pipedog: a port of Pipecat's `FunASRSTTService`. SenseVoice is multilingual (Chinese,
Cantonese, English, Japanese, Korean) with strong Chinese accuracy and fast non-autoregressive
inference, and it also tags emotion and audio events.

Upstream runs the model with the `funasr` Python package (PyTorch). This package runs the same
weights through [`@pipedog/onnx`](../onnx) (onnxruntime), with a small TypeScript engine
(`@pipedog/funasr/funasr`) that mirrors the part of `funasr` the service uses: `AutoModel`,
`generate()` and `richTranscriptionPostprocess()`.

```ts
import { FunASRSTTService, FunASRSTTSettings } from "@pipedog/funasr";
import { Language } from "@pipedog/core/transcriptions/language";

const stt = new FunASRSTTService({
  settings: new FunASRSTTSettings({ language: Language.ZH, useItn: true }),
});
```

It is a `SegmentedSTTService`: put a VAD in front of it (it transcribes each speech segment) and
feed it 16 kHz 16-bit mono PCM, like upstream.

## Install

```sh
bun add @pipedog/funasr onnxruntime-node
```

`onnxruntime-node` is an optional peer of `@pipedog/onnx`; `onnxruntime-web@1.30.0` (WASM) works
too, about 10x slower (1.2 s instead of 0.11 s for a 7 s clip on an M4 Pro).

## What you need

| | |
|---|---|
| model | sherpa-onnx's ONNX export of `iic/SenseVoiceSmall`, from Hugging Face [`csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17) (pinned revision): `model.int8.onnx` (239 MB, default) or `model.onnx` (938 MB, `modelOptions: { quantized: false }`), plus `tokens.txt` (316 KB) |
| download | automatic, once, on `start()` or the first transcription; no account or token needed |
| cache | `$PIPEDOG_CACHE_DIR/funasr`, else `$XDG_CACHE_HOME/pipedog/funasr`, else `~/.cache/pipedog/funasr`; or `modelOptions: { cacheDir }` |

To use local files instead, set the `model` setting to a directory holding `model.int8.onnx` (or
`model.onnx`) and `tokens.txt`, or to the `.onnx` file's path (with `tokens.txt` next to it), or
pass explicit files:

```ts
new FunASRSTTService({
  settings: new FunASRSTTSettings({ model: "/models/sense-voice" }),
});
new FunASRSTTService({
  modelOptions: { modelFile: "/models/model.int8.onnx", tokens: "/models/tokens.txt" },
});
```

The `model` setting accepts `"iic/SenseVoiceSmall"` (default) and `"FunAudioLLM/SenseVoiceSmall"`
for the download; FunASR's PyTorch checkpoints and other ModelScope model ids are not supported.

## Options

`FunASRSTTService` takes everything `SegmentedSTTService` does, plus:

| option | default | |
|---|---|---|
| `device` | `"cpu"` | accepted for compatibility; inference always runs on the CPU |
| `settings` | `model: "iic/SenseVoiceSmall"`, `language: Language.EN`, `useItn: true` | `language` other than zh/en/ja/ko/yue means auto-detect; `useItn` adds punctuation and digits |
| `modelOptions` | | pipedog only: `cacheDir`, `quantized`, `modelFile`, `tokens`, `backend`, `shareSession`, `fetch` |

### The engine

```ts
import { AutoModel, richTranscriptionPostprocess } from "@pipedog/funasr";

const model = new AutoModel({ model: "iic/SenseVoiceSmall" });
const [result] = await model.generate({ input: samples /* Float32Array, 16 kHz, [-1, 1] */, language: "auto", useItn: true });
result.text; // "<|en|><|NEUTRAL|><|Speech|><|withitn|>The tribal chieftain called for the boy..."
richTranscriptionPostprocess(result.text); // "The tribal chieftain called for the boy..."
```

It computes FunASR's `WavFrontend` features (Kaldi fbank: 80 mel bins, 25 ms Hamming window,
10 ms shift, pre-emphasis 0.97, `snip_edges`, int16-scaled samples; LFR 7/6; CMVN from the
model's metadata), runs the model, and decodes as FunASR does (CTC greedy search, SentencePiece
detokenization), so `generate()` returns FunASR's raw text with its `<|...|>` tags. The features
match kaldi-native-fbank to within 2e-4 and the transcripts match sherpa-onnx's for the same model.

## Runtimes

| class | Bun | Node | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `FunASRSTTService`, `AutoModel` | ✅ | ✅ | ✅ | ❌ (model too large for Workers' memory) |

## Differences from upstream

- The model runs on onnxruntime (CPU), not PyTorch; `device: "cuda"` does not select a GPU.
- The model loads (and downloads) in `start()` or on the first transcription, not in the
  constructor.
- No dither in the front end (FunASR's `WavFrontend` adds dither 1.0 by default), so results are
  deterministic.
- The engine's options are camelCase (`disableUpdate`, `useItn`).

## Licenses

- This package: BSD-2-Clause. `src/postprocess_utils.ts` is adapted from
  [FunASR](https://github.com/modelscope/FunASR) (MIT, Copyright (c) 2022 Alibaba).
- SenseVoiceSmall weights: the [FunASR model license](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)
  (attribution required; check its terms for your use). The ONNX export is by k2-fsa/sherpa-onnx.
