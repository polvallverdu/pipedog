# @pipedog/whisper

Whisper for pipedog:

- **`BaseWhisperSTTService`** (`@pipedog/whisper/base_stt`): the base speech-to-text service for
  Whisper-compatible APIs. It sends each user utterance (segmented by VAD) to an OpenAI-style
  `audio/transcriptions` endpoint through the official `openai` JS SDK. It is shared by the
  services that speak the Whisper protocol, such as `OpenAISTTService` in
  [`@pipedog/openai`](https://www.npmjs.com/package/@pipedog/openai) and `GroqSTTService`.
- **Probability helpers** (`@pipedog/whisper/utils`): `extractWhisperProbability`,
  `extractOpenaiGpt4oProbability`, `extractDeepgramProbability`.
- **Local Whisper** (`@pipedog/whisper/stt`): `WhisperSTTService` and `WhisperSTTServiceMLX`
  transcribe on your machine, with no API. They run faster-whisper's algorithm on ONNX Runtime
  (`@pipedog/whisper/faster_whisper`), with ONNX exports of the same Whisper checkpoints.

A port of Pipecat's `pipecat.services.whisper` (`base_stt`, `stt`, `utils`). The package root
re-exports `base_stt` and `utils`. Import the local services from `@pipedog/whisper/stt`: they
pull in the ONNX runtime and a tokenizer, which the API services don't need.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/whisper
# For the local services, also an ONNX runtime:
bun add onnxruntime-node        # native, fastest (Bun, Node, Deno)
# or: bun add onnxruntime-web@1.30.0   (WebAssembly)
```

The ONNX runtimes are optional peer dependencies of `@pipedog/onnx`. The tokenizer
([`@huggingface/tokenizers`](https://www.npmjs.com/package/@huggingface/tokenizers), pure JS) is a
dependency.

## Usage

```ts
import { BaseWhisperSTTService } from "@pipedog/whisper/base_stt";

// Any server that implements OpenAI's /audio/transcriptions API:
const api = new BaseWhisperSTTService({
  apiKey: process.env.WHISPER_API_KEY ?? null,
  baseUrl: "http://localhost:8000/v1",
});
```

```ts
import { Language } from "@pipedog/core/transcriptions/language";
import { Model, WhisperSTTService } from "@pipedog/whisper/stt";

const stt = new WhisperSTTService({
  computeType: "int8", // smaller download, faster on CPU
  settings: new WhisperSTTService.Settings({
    model: Model.LARGE_V3_TURBO,
    language: Language.ES,
    hotwords: "Pipecat pipedog",
  }),
});
```

The engine also works on its own, with faster-whisper's API:

```ts
import { WhisperModel } from "@pipedog/whisper/faster_whisper";

const model = new WhisperModel("tiny", { computeType: "int8" });
const [segments, info] = await model.transcribe(float32Audio16k, { language: null });
for await (const s of segments) console.log(info.language, s.start, s.end, s.text, s.noSpeechProb);
```

The local services expect 16 kHz input (the pipeline's input sample rate), as upstream does.

## What you need (local services)

The model files download on first use (when the pipeline starts) from Hugging Face into
`$PIPEDOG_CACHE_DIR/whisper`, else `$XDG_CACHE_HOME/pipedog/whisper`, else
`~/.cache/pipedog/whisper` (one folder per repo). Override with
`modelOptions: { downloadRoot }`, use `modelOptions: { localFilesOnly: true }` to never download,
pass a local directory with the same layout as the model name, or pass every file explicitly
(bytes, paths or URLs) with `modelOptions: { files: { "config.json", "generation_config.json",
"preprocessor_config.json", "tokenizer.json", encoder, decoder } }`.

Upstream's model names map to the ONNX export of the same checkpoint:

| `Model` / name | ONNX repo | default download (fp32 encoder + int8 decoder) | `computeType: "int8"` |
|---|---|---|---|
| `tiny` | `onnx-community/whisper-tiny` | 64 MB | 41 MB |
| `base` | `onnx-community/whisper-base` | 136 MB | 77 MB |
| `small` | `onnx-community/whisper-small` | 510 MB | 249 MB |
| `medium` | `onnx-community/whisper-medium-ONNX` | 1.9 GB | 986 MB |
| `large-v3` (`LARGE`) | `onnx-community/whisper-large-v3-ONNX` | 3.7 GB | 1.8 GB |
| `LARGE_V3_TURBO` (`deepdml/faster-whisper-large-v3-turbo-ct2`) | `onnx-community/whisper-large-v3-turbo` | 3.0 GB | 1.1 GB |
| `DISTIL_LARGE_V2` (`Systran/faster-distil-whisper-large-v2`) | `distil-whisper/distil-large-v2` | 2.7 GB | 767 MB |
| `DISTIL_MEDIUM_EN` (`Systran/faster-distil-whisper-medium.en`, the default) | `distil-whisper/distil-medium.en` | 1.3 GB | 402 MB |

Plus the tokenizer (2.5 MB) and configs. Every other faster-whisper name works too (`tiny.en`,
`base.en`, `small.en`, `medium.en`, `large-v1`, `large-v2`, `distil-small.en`,
`distil-large-v3`, `distil-large-v3.5`, `large-v3-turbo`, `turbo`), as does any Hugging Face repo
with the same ONNX layout (`onnx/encoder_model*.onnx`, `onnx/decoder_model_merged*.onnx`).

`computeType` (faster-whisper's `compute_type`) picks the weight variant: `default` = fp32 encoder
and int8 (`q8`) decoder; `int8*` = `q8` for both; `float32` = fp32 for both; or an ONNX dtype
(`fp32`, `q8`, `int8`, `uint8`, `q4`, `bnb4`), or `modelOptions: { dtype: { encoder, decoder } }`.
The `distil-whisper/*` exports have only `fp32` and `q8`. fp16 variants aren't supported. The
large fp32 encoders/decoders keep their weights in a separate `.onnx_data` file, which needs
`onnxruntime-node` (onnxruntime-web loads models from bytes): use `int8` with onnxruntime-web.
`device: "cpu"` forces the CPU provider; `cuda` is not selectable.

## Runtimes

| Class | Bun | Node.js 22+ | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `BaseWhisperSTTService`, utils | yes | yes | yes | yes |
| `WhisperSTTService`, `WhisperSTTServiceMLX`, `WhisperModel` | yes | yes | yes | no (model sizes; the code itself is smoke-tested there with a fake engine) |

## How local Whisper compares to Pipecat's

Upstream wraps faster-whisper (CTranslate2), and on Apple Silicon mlx_whisper. Neither runs in
JavaScript, so `faster_whisper.ts` re-implements what the service uses from faster-whisper, with
its algorithm: the same log-mel features (verified to 6e-6 against faster-whisper's), the same
prompt (SOT sequence, language/task tokens, timestamps mode, `initial_prompt`, `hotwords` after
`<|startofprev|>`), `no_speech_prob` at the start-of-transcript position, `suppress_tokens` (`-1`)
and `suppress_blank`, the timestamp rules, beam search (beam 5, run as one batch with a shared KV
cache), the temperature fallback with best-of-5 sampling, segment splitting, and language
detection. With fp32 weights, whisper tiny gives the same text, `avg_logprob` and
`no_speech_prob` (to 4 decimals) as faster-whisper on the test clip.

Differences:

- The weights are ONNX exports of the same checkpoints, not the CTranslate2 conversions; int8
  quantization differs from CTranslate2's, so quantized outputs differ slightly.
- Not implemented (faster-whisper options the service never uses): `vad_filter`,
  `word_timestamps`, `hallucination_silence_threshold`, `clip_timestamps`, per-window
  `multilingual`, `repetition_penalty`, `no_repeat_ngram_size`, the batched pipeline.
- Sampling at temperature > 0 uses `Math.random` (no seed); the gzip compression ratio uses the
  platform's `CompressionStream("deflate")`.
- Model files load in `start()` (upstream: in the constructor, blocking); a failed load is
  reported as an error and retried on the next segment. The English-only language check still
  runs in the constructor for faster-whisper's names; for custom models, after loading.
- There are no threads: segments are consumed on the event loop. Each decoder step awaits the
  runtime (onnxruntime-node runs it on its own threads); feature extraction (about 25 ms for
  11 s of audio) runs inline.
- `WhisperSTTServiceMLX` is **not MLX**: same class, settings and filtering as upstream, with the
  `MLXModel` names mapped to the ONNX export of the same checkpoint (`LARGE_V3_TURBO_Q4` → 4-bit
  `q4` weights), decoded like mlx_whisper (greedy, the configured temperature only). Its features
  are faster-whisper's, not mlx_whisper's (which pads 30 s of silence before computing them).
- Not ported: the deprecated constructor arguments (`model`, `no_speech_prob`, `language`,
  `temperature`); use `settings`.

Alternatives considered: transformers.js (`@huggingface/transformers`) brings sharp,
onnxruntime-node and onnxruntime-web, doesn't expose `no_speech_prob` or hotwords, and can't share
sessions through `@pipedog/onnx`. whisper.cpp addons are native, Node-only and use GGML models
(a different engine). node-llama-cpp runs LLMs only.

## Licenses

- Code: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). `faster_whisper.ts`
  follows faster-whisper (MIT, Copyright (c) 2023 SYSTRAN) and OpenAI Whisper (MIT).
- Models: OpenAI Whisper weights are MIT; the distil-whisper models are MIT. The ONNX exports are
  by the Hugging Face `onnx-community` / `Xenova` / `distil-whisper` accounts.
- `@huggingface/tokenizers`: Apache-2.0.

## Links

- Docs: [voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/),
  [coming from Pipecat](https://polvallverdu.github.io/pipedog/docs/coming-from-pipecat/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause. See [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
