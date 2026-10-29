# @pipedog/nvidia

NVIDIA services for pipedog:

- `NvidiaLLMService`: chat completions from NVIDIA NIM, on NVIDIA's cloud
  (`https://integrate.api.nvidia.com/v1`) or a local NIM. An `OpenAILLMService` subclass that turns
  a model's reasoning (`reasoning_content`, or a leading `<think>` block) into `LLMThought*Frame`s.
- `NvidiaOmniLLMService`: Nemotron Omni, which takes speech, images and video as well as text. By
  default it hears the user directly and transcribes and answers each spoken turn in one request,
  in place of an STT service; with `audioInput: false` it is a text LLM. `runMultimodalInference()`
  analyzes media outside the pipeline. Its messages go through `NvidiaOmniLLMAdapter`.

A port of Pipecat's `pipecat.services.nvidia` and `pipecat.adapters.llm.services.nvidia_omni_adapter`.
Subpaths mirror upstream: `@pipedog/nvidia/llm`, `/omni/llm`, `/nvidia_omni_adapter`.

Riva speech-to-text and text-to-speech (`NvidiaSTTService`, `NvidiaSegmentedSTTService`,
`NvidiaTTSService`) and the SageMaker variants are not ported yet.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/openai @pipedog/nvidia
```

## Usage

```ts
import { NvidiaLLMService } from "@pipedog/nvidia/llm";
import { NvidiaOmniLLMService } from "@pipedog/nvidia/omni/llm";

const llm = new NvidiaLLMService({
  apiKey: process.env.NVIDIA_API_KEY ?? "",
  settings: new NvidiaLLMService.Settings({ model: "nvidia/nemotron-3.5-super-vl-120b-a12b" }),
});

// A local NIM takes no key.
const local = new NvidiaLLMService({ baseUrl: "http://localhost:8000/v1" });

// Omni hears the user: no STT service in the pipeline.
const omni = new NvidiaOmniLLMService({ apiKey: process.env.NVIDIA_API_KEY ?? "" });
// new Pipeline([transport.input(), userAggregator, omni, tts, transport.output(), assistantAggregator])
```

With Omni in audio input mode, read the user's text from the user aggregator's
`on_user_turn_message_added` event: it is known once Omni has transcribed the turn.

## Runtimes

Bun, Node.js 22+ and Cloudflare Workers: HTTP goes through the `openai` SDK's `fetch`.

The deprecated `model` constructor option is not ported; use `settings`.

## Links

- Docs: [NVIDIA](https://polvallverdu.github.io/pipedog/docs/services/llm/nvidia/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
