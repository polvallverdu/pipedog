# @pipedog/kokoro

Local [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) text-to-speech for pipedog:
`KokoroTTSService`, a port of Pipecat's `pipecat.services.kokoro.tts`, and `Kokoro`, the engine
behind it, a TypeScript reimplementation of the Python
[kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) package (0.6.1) on
[`@pipedog/onnx`](../onnx) and [`@pipedog/espeak-ng`](../espeak-ng).

```ts
import { KokoroTTSService } from "@pipedog/kokoro";

const tts = new KokoroTTSService({
  settings: new KokoroTTSService.Settings({ voice: "af_heart", speed: 1.0 }),
});
```

## Install

```sh
bun add @pipedog/kokoro onnxruntime-node @echogarden/espeak-ng-emscripten
```

- `onnxruntime-node` (or `onnxruntime-web@1.30.0`, slower): runs the model.
- `@echogarden/espeak-ng-emscripten` (GPL-3.0): eSpeak NG as WebAssembly, for phonemization.

## What you need

The same files upstream uses, from the kokoro-onnx `model-files-v1.0` release, downloaded on first
use (in `start()`) if missing:

| file | size | default location |
|---|---|---|
| `kokoro-v1.0.onnx` | 310 MiB | `<cache>/kokoro-v1.0.onnx` |
| `voices-v1.0.bin` (54 voices) | 27 MiB | `<cache>/voices-v1.0.bin` |

`<cache>` is `modelCacheDir("kokoro")`: `$PIPEDOG_CACHE_DIR/kokoro`, else
`$XDG_CACHE_HOME/pipedog/kokoro`, else `~/.cache/pipedog/kokoro` (upstream:
`~/.cache/pipecat/kokoro-onnx`). The same release has smaller variants of the model, e.g.
`kokoro-v1.0.int8.onnx` (88 MiB):

```ts
new KokoroTTSService({
  modelPath: "/models/kokoro-v1.0.int8.onnx", // used as is if present...
  modelUrl: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx", // ...else downloaded from here
  voicesPath: "/models/voices-v1.0.bin",
  settings: new KokoroTTSService.Settings({ voice: "af_heart" }),
});
```

Options beyond upstream's (`modelPath`, `voicesPath`, `settings`): `cacheDir`, `modelUrl`,
`voicesUrl`, `fetch` (for downloads), `backend` (an `OnnxBackend`), `shareSession` (default `true`:
services in one process share one model session and one copy of the voices).

Languages (`settings.language`): English (US, GB), Spanish, French, Hindi, Italian, Japanese,
Portuguese (PT, BR) and Mandarin, mapped to espeak-ng codes by `languageToKokoroLanguage()`. Pick a
voice for the language (`af_*`/`am_*` American English, `bf_*`/`bm_*` British, `ef_*` Spanish,
`ff_*` French, `hf_*` Hindi, `if_*` Italian, `jf_*` Japanese, `pf_*` Portuguese, `zf_*` Mandarin).

## The engine

```ts
import { Kokoro } from "@pipedog/kokoro";

const kokoro = await Kokoro.load("kokoro-v1.0.onnx", "voices-v1.0.bin");
for await (const [samples, sampleRate] of kokoro.createStream("Hello there!", {
  voice: "af_heart",
  lang: "en-us",
})) {
  // Float32Array at 24000 Hz, one chunk per phoneme batch
}
```

Same pipeline as kokoro-onnx: espeak-ng phonemization with phonemizer's algorithm (punctuation
and stress kept, out-of-vocabulary symbols dropped), batches of at most 510 phonemes split at
sentence, clause, then word boundaries and balanced in size, token ids padded with 0, the voice's
style vector for the token count, the speed input, then librosa-style silence trimming and
0.25 s / 0.1 s pauses after sentence / clause marks between batches. The next batch is synthesized
while the current one plays. Verified bit-identical to kokoro-onnx 0.6.1's audio for the int8 model.

Not ported: timed synthesis (`create_timed`, `continuous`), which needs a re-exported model with a
duration output; reading a vocabulary embedded in the model metadata (pass `vocab`); input types
are not read from the model (the v1.0 types are assumed; pass `inputTypes` for exports with an
integer speed).

## Runtimes

| class | Bun | Node | Deno | Workers |
|---|---|---|---|---|
| `KokoroTTSService`, `Kokoro` | ✅ | ✅ | ✅ | ❌ (model and voice data exceed Workers' memory and bundle limits) |

## Divergences from upstream

- The model is downloaded and loaded in `start()` (or on first use), not in the constructor, since
  loading is asynchronous. A missing or blank voice is still rejected by the constructor; a voice
  that is not in the voices file is reported when the model loads.
- Default cache directory: `~/.cache/pipedog/kokoro` instead of `~/.cache/pipecat/kokoro-onnx`.
- The deprecated `voice_id` / `params` (`InputParams`) arguments are not ported; use `settings`.
- Rejected alternative engine: [`kokoro-js`](https://www.npmjs.com/package/kokoro-js) (built on
  transformers.js, pulls in sharp and its own onnxruntime, phonemizes only en-us / en-gb, uses a
  different model export and voice format, and can't share sessions).

## License

BSD 2-Clause. The Kokoro-82M model and voices are Apache-2.0 (hexgrad); the ONNX export and voice
pack are from kokoro-onnx (MIT). Phonemization uses eSpeak NG (GPL-3.0) through
`@echogarden/espeak-ng-emscripten`, as upstream's kokoro-onnx does through espeakng-loader.
