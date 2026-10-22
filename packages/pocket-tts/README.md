# @pipedog/pocket-tts

Local text-to-speech with Kyutai's [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) for
pipedog: a port of Pipecat's `PocketTTSService`. Pocket TTS is a 100M-parameter streaming TTS
that runs faster than real time on a CPU, with no GPU and no API key.

Upstream wraps the `pocket_tts` Python package (PyTorch). This package runs the same model on
ONNX Runtime through [`@pipedog/onnx`](../onnx), with a TypeScript engine
(`@pipedog/pocket-tts/pocket_tts`) that exposes the same `TTSModel` surface the service uses
(`loadModel`, `sampleRate`, `getStateForAudioPrompt`, `generateAudioStream`) and reimplements
the parts of pocket-tts around the network: the SentencePiece tokenizer, text preparation and
chunking, the autoregressive flow-LM loop with its KV cache, the LSD flow-matching sampler
(`temp`, `lsdDecodeSteps`, `noiseClamp`), end-of-speech handling, and streaming Mimi decoding
(one 80 ms frame at a time).

```ts
import { PocketTTSService, PocketTTSSettings } from "@pipedog/pocket-tts";
import { Language } from "@pipedog/core/transcriptions/language";

const tts = new PocketTTSService({
  settings: new PocketTTSSettings({ voice: "alba", language: Language.EN }),
});
```

At `temp = 0` (deterministic) it produces the same audio as pocket-tts 2.1.0 to within 2e-4 per
sample (the e2e test checks this); at the default `temp = 0.7` the noise comes from a different
generator, so the audio differs sample by sample as two seeds would.

## Install

```sh
bun add @pipedog/pocket-tts onnxruntime-node
```

`onnxruntime-node` is an optional peer of `@pipedog/onnx` and is required here: onnxruntime-web
1.30 can't read the graphs' empty (zero-length) state outputs.

## What you need

| | |
|---|---|
| graphs | the ONNX export of Kyutai's weights in [`KevinAHM/pocket-tts-onnx`](https://huggingface.co/KevinAHM/pocket-tts-onnx) (CC-BY-4.0, ungated), pinned to revision `58a6d00`: `text_conditioner.onnx`, `flow_lm_main.onnx` (or `flow_lm_main_int8.onnx` with `quantize`), `flow_lm_flow.onnx`, `mimi_decoder.onnx`, `bundle.json` |
| tokenizer, voices | Kyutai's own files from the ungated [`kyutai/pocket-tts-without-voice-cloning`](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning), at the revisions pocket-tts 2.1.0 pins: `languages/<language>/tokenizer.model` and the predefined voice states `languages/<language>/embeddings/<voice>.safetensors` |
| sizes | 6-layer languages: 405 MB (fp32), 180 MB with `quantize`; `french_24l`: 1.31 GB (fp32), 400 MB with `quantize`; each voice ~6 MB |
| download | automatic, once, on `start()` or the first utterance |
| cache | `$PIPEDOG_CACHE_DIR/pocket-tts`, else `$XDG_CACHE_HOME/pipedog/pocket-tts`, else `~/.cache/pipedog/pocket-tts`; or `modelOptions.cacheDir`. Files go in `<cacheDir>/<repo>/<revision>/<path>` |

To use files you already have, put them in one directory (`bundle.json`, the `.onnx` files,
`tokenizer.model`, optionally `embeddings/<voice>.safetensors`) and pass
`modelOptions: { modelDir }`; anything missing there is downloaded.

The engine can be used directly:

```ts
import { TTSModel } from "@pipedog/pocket-tts";

const model = await TTSModel.loadModel({ language: "english", temp: 0.7 });
const voice = await model.getStateForAudioPrompt("alba");
for await (const chunk of model.generateAudioStream(voice, "Hello world.")) {
  // chunk: Float32Array of 1920 samples at model.sampleRate (24000)
}
```

### Languages

`languageToPocketTtsLanguage` maps `Language.EN/DE/ES/IT/PT/FR` (and regional variants) to the
pocket-tts models `english`, `german`, `spanish`, `italian`, `portuguese` and `french_24l`, as
upstream. For these six, every exported module was checked against pocket-tts 2.1.0 (PyTorch)
and agrees to ~1e-6 relative error. `TTSModel.loadModel` also accepts `german_24l`,
`italian_24l`, `portuguese_24l` and `spanish_24l` (same export, not checked numerically).

### Voices

- the 26 predefined voices (`alba`, `marius`, `javert`, `jean`, `fantine`, `cosette`,
  `eponine`, `azelma`, `anna`, `vera`, `charles`, `paul`, `george`, `mary`, `jane`, `michael`,
  `eve`, `bill_boerst`, `peter_yearsley`, `stuart_bell`, `caro_davy`, `giovanni`, `lola`,
  `juergen`, `rafael`, `estelle`), downloaded per language;
- a `.safetensors` voice state (path, `https://` or `hf://` URL), e.g. from
  `pocket-tts export-voice`;
- a WAV file to clone (path, `https://` or `hf://` URL). Cloning needs the Mimi encoder with
  Kyutai's speaker projection, which only exists in the **gated** `kyutai/pocket-tts` weights
  (pocket-tts refuses to clone without access to them too). It is not downloaded for you: accept
  Kyutai's terms, export the encoder to ONNX (input `audio` [1, 1, samples] at 24 kHz, output
  the projected latents [1, frames, 1024]) and pass it as `modelOptions.voiceCloningModel`.
  Community exports of that encoder exist (e.g. `mimi_encoder.onnx` in `KevinAHM/pocket-tts-onnx`,
  derived from the gated weights); using one is subject to Kyutai's terms. This path was not
  checked against upstream.

## Options

`PocketTTSService` takes everything `TTSService` does, plus:

| option | default | |
|---|---|---|
| `settings` | `voice: "alba"`, `language: Language.EN` | the voice is runtime-updatable (re-derived on the next utterance); language changes are stored but not applied, as upstream |
| `temp` | 0.7 (model default) | sampling temperature |
| `quantize` | false | int8 flow-LM transformer (`flow_lm_main_int8.onnx`) |
| `modelOptions` | | `TTSModel.loadModel` options (pipedog only): `backend`, `sessionOptions` (default `{ intraOpNumThreads: 4, interOpNumThreads: 1 }`), `shareSessions`, `modelDir`, `cacheDir`, `fetch`, `hfToken` (default `$HF_TOKEN`, sent to huggingface.co only), `voiceCloningModel`, `lsdDecodeSteps` (1), `noiseClamp` (null), `eosThreshold` (-4), `random` |

## Runtimes

| class | bun | node | deno | workerd |
|---|---|---|---|---|
| `PocketTTSService`, `TTSModel` | yes | yes | yes | no |

On Cloudflare Workers the flow LM graph (76 MB-1.2 GB) and its ~50 MB per-step KV-cache state
don't fit the memory and bundle limits.

Timings, Apple M4 Pro, Bun, onnxruntime-node, English: 2.24 s of audio in 0.37 s (6x real
time), first 80 ms chunk after ~45 ms; loading 0.25 s from the cache.

## Differences from upstream

- The model and the voice state load in `start()` (or on the first utterance), not in the
  constructor; the constructor still rejects a missing voice or language.
- Sampling noise comes from `Math.random` (or the `random` option), not torch's generator.
- `quantize` uses ONNX Runtime's dynamic int8 quantization of the flow-LM transformer instead of
  torchao's (the same layers: attention and FFN; the flow net and Mimi stay fp32), so the
  quantized output is not bit-identical to upstream's.
- The exported flow LM has a fixed 1000-position KV cache (voice prompt + text tokens +
  generated frames); pocket-tts sizes its cache per utterance. A text chunk whose generation
  budget would overflow it is cut short with a warning (pocket-tts' 50-token chunks with the
  predefined voices stay far below the limit).
- Audio prompts are read from WAV only (upstream reads any format through soundfile/av) and
  resampled to 24 kHz with soxr at 16-bit precision (upstream: julius, float).
- `TTSModel.loadModel` has no `config` argument (custom YAML model configs).
- Generation and Mimi decoding overlap in one async loop (the next flow-LM step runs while the
  current frame decodes) instead of two threads.

## License

BSD 2-Clause. The engine reimplements parts of
[pocket-tts](https://github.com/kyutai-labs/pocket-tts) (MIT) and of SentencePiece's Unigram
encoder (Apache-2.0). The models are downloaded at runtime, not shipped: Kyutai's Pocket TTS
weights, tokenizers and voices are CC-BY-4.0 (attribution: Kyutai), and so is the ONNX export.
Kyutai's terms forbid voice impersonation or cloning without consent, among other uses.
