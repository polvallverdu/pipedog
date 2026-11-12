# @pipedog/tone

Pipecat Tone's models for pipedog: the reader (`PipecatToneReaderModel`, how each user turn was
meant: emotion, sarcasm, the move it makes, backchannels) and the tagger (`PipecatToneTaggerModel`,
expression tags for an LLM's plain replies). They are small ONNX models from
[`pipecat-ai/tone-models`](https://huggingface.co/pipecat-ai/tone-models) on Hugging Face, run on
the CPU through [`@pipedog/onnx`](../onnx) with `@huggingface/tokenizers`.

The processors that use them, `PipecatToneReader` and `PipecatToneTagger`, are in `@pipedog/core`
(`@pipedog/core/processors/tone/reader/index`, `/tagger/index`), which loads this package when it
is installed. Part of expressive conversation (alpha).

A port of Pipecat's `pipecat.processors.tone.reader.model` and `pipecat.processors.tone.tagger.model`.
Subpaths mirror upstream: `@pipedog/tone/reader/model`, `@pipedog/tone/tagger/model`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/tone onnxruntime-node
```

`onnxruntime-node` or `onnxruntime-web` is an optional peer of `@pipedog/onnx`.

## Usage

Most bots only add the processors; the models download on first use into
`~/.cache/pipedog/tone` (or `$PIPEDOG_CACHE_DIR/tone`):

```ts
import { PipecatToneReader } from "@pipedog/core/processors/tone/reader/index";
import { PipecatToneTagger } from "@pipedog/core/processors/tone/tagger/index";
import { PipelineParams } from "@pipedog/core/pipeline/worker";

// new Pipeline([transport.input(), stt, new PipecatToneReader(), userAggregator, llm,
//   new PipecatToneTagger(), tts, transport.output(), assistantAggregator])
const params = new PipelineParams({ enableExpressiveConversation: true });
```

The models can also be used on their own:

```ts
import { PipecatToneReaderModel } from "@pipedog/tone/reader/model";

const reader = await PipecatToneReaderModel.download(); // or .load(modelDir)
const tags = await reader.tag("Oh great, another delay.", "Your order ships next week.");
console.log(tags.emotion.probabilities, tags.sarcasm.probability);
```

## Runtimes

Bun and Node.js 22+, on onnxruntime-node or onnxruntime-web. `load()` takes a folder path or
an `http(s):` / `file:` URL. Cloudflare Workers have no file system to cache a download in, so
`download()` can't run there: host the model files and pass their `https:` URL as `modelDir`.

Upstream loads a model in its constructor and reads synchronously off the event loop. Loading is
async here (`load()` / `download()`), and `tag()` returns a promise.

## Links

- Docs: [Pipecat Tone](https://polvallverdu.github.io/pipedog/docs/concepts/tone/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE). The models are
  downloaded at runtime, not shipped; see their Hugging Face page for their license.
