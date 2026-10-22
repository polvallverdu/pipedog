# @pipedog/piper

[Piper](https://github.com/OHF-Voice/piper1-gpl) text-to-speech for pipedog, a port of Pipecat's
`pipecat.services.piper.tts`:

- `PiperTTSService`: runs Piper voices locally. Its engine (`@pipedog/piper/piper_voice`) is a
  TypeScript reimplementation of what upstream uses from the Python `piper-tts` package (1.8.0) on
  [`@pipedog/onnx`](../onnx) and [`@pipedog/espeak-ng`](../espeak-ng).
- `PiperHttpTTSService`: talks to a [Piper HTTP server](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_HTTP.md)
  over `fetch`; runs anywhere, Cloudflare Workers included.

```ts
import { PiperHttpTTSService, PiperTTSService } from "@pipedog/piper";

const local = new PiperTTSService({
  settings: new PiperTTSService.Settings({ voice: "en_US-ryan-high" }),
});

const remote = new PiperHttpTTSService({
  baseUrl: "http://localhost:5000",
  settings: new PiperHttpTTSService.Settings({ voice: "en_US-ryan-high" }),
});
```

## Install

```sh
bun add @pipedog/piper
# for PiperTTSService (local voices) only:
bun add onnxruntime-node @echogarden/espeak-ng-emscripten
```

- `onnxruntime-node` (or `onnxruntime-web@1.30.0`, slower): runs the voice model.
- `@echogarden/espeak-ng-emscripten` (GPL-3.0): eSpeak NG as WebAssembly, for phonemization.

`PiperHttpTTSService` needs neither: the local engine is imported lazily, only by `PiperTTSService`.

## What you need (`PiperTTSService`)

A Piper voice: `<voice>.onnx` and `<voice>.onnx.json` from Hugging Face
[`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices), downloaded on first use (in
`start()`) into `downloadDir` if missing, exactly as `piper.download_voices` does. Sizes depend on
the quality: `x_low` 20-28 MB and `low` 28-69 MB (16 kHz), `medium` 62-81 MB and `high`
63-136 MB (22.05 kHz). Audio is resampled to the pipeline's rate.

`downloadDir` defaults to `modelCacheDir("piper")`: `$PIPEDOG_CACHE_DIR/piper`, else
`$XDG_CACHE_HOME/pipedog/piper`, else `~/.cache/pipedog/piper` (upstream: `~/.cache/pipecat/piper`).
Put the two files there yourself to skip the download.

Options: `downloadDir`, `forceRedownload`, `useCuda` (accepted, no effect, see below), `settings`;
beyond upstream: `fetch` (for downloads) and `backend` (an `OnnxBackend`). Voices are shared: two
services with the same voice in one process use one model session.

## The engine

```ts
import { downloadVoice, PiperVoice } from "@pipedog/piper/piper_voice";

await downloadVoice("en_US-lessac-medium", "/models");
const voice = await PiperVoice.load("/models/en_US-lessac-medium.onnx");
for await (const chunk of voice.synthesize("Hello world. How are you?")) {
  chunk.audioInt16Bytes; // one sentence, 16-bit PCM at voice.config.sampleRate
}
```

Same pipeline as piper-tts: espeak-ng phonemizes clause by clause with the voice's
`espeak.voice`; language-switch flags are removed, the clause's punctuation is kept (plus a space
after `,` `:` `;`), phonemes are NFD-decomposed into code points (vowel clusters merged when the
config lists them), and sentences end where espeak-ng ends them; `[[ ... ]]` passes raw phonemes.
Ids are `^`, each phoneme followed by the pad `_`, then `$`. Inference feeds `input`,
`input_lengths`, `scales` (`[noise_scale, length_scale, noise_w]` from the config or a
`SynthesisConfig`) and `sid` for multi-speaker voices; audio is peak-normalized, scaled by
`volume`, clipped, and converted with `clip(x * 32767)`.

Phonemes match piper-tts 1.8.0's for the tested languages, except where piper-tts bundles newer
espeak-ng data (`en-gb-x-rp`, `pt-br`, `it` differ slightly); see `@pipedog/espeak-ng`.

Not ported: phoneme types other than `espeak` and `text` (Chinese, Hebrew, Japanese and Thai voices
need other G2P models), Arabic diacritization (tashkeel), phoneme/audio alignments.

## Runtimes

| class | Bun | Node | Deno | Workers |
|---|---|---|---|---|
| `PiperHttpTTSService` | ✅ | ✅ | ✅ | ✅ |
| `PiperTTSService` | ✅ | ✅ | ✅ | ❌ (needs a filesystem; model and espeak-ng data exceed Workers' limits) |

## Divergences from upstream

- `PiperTTSService` downloads and loads the voice in `start()` (or on first use), not in the
  constructor, since loading is asynchronous. A missing or blank voice is still rejected by the
  constructor, before anything is downloaded.
- Default download directory: `~/.cache/pipedog/piper` instead of `~/.cache/pipecat/piper`.
- `useCuda` is accepted but has no effect: `@pipedog/onnx` sessions run on the backend's default
  (CPU) execution provider.
- `PiperHttpTTSService`: upstream's required `aiohttp_session` is an optional `fetch`.
- The deprecated `voice_id` argument is not ported; use `settings`.

## License

BSD 2-Clause. Piper voices have their own licenses (see each voice's `MODEL_CARD` on Hugging Face).
`PiperTTSService` phonemizes with eSpeak NG (GPL-3.0) through `@echogarden/espeak-ng-emscripten`;
upstream's `PiperTTSService` uses `piper-tts`, which is GPL-3.0 itself. To keep GPL code out of your
application, use `PiperHttpTTSService` with a separately installed Piper server.
