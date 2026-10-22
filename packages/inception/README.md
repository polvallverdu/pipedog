# @pipedog/inception

Inception services for pipedog: `InceptionLLMService`, chat completions with Inception's
Mercury models (an `OpenAILLMService` subclass pointed at `https://api.inceptionlabs.ai/v1`), with
the `reasoning_effort` and `realtime` settings.

A port of Pipecat's `pipecat.services.inception`. The subpath mirrors upstream:
`@pipedog/inception/llm`.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/openai @pipedog/inception
```

## Usage

```ts
import { InceptionLLMService } from "@pipedog/inception/llm";

const llm = new InceptionLLMService({
  apiKey: process.env.INCEPTION_API_KEY ?? "",
  settings: new InceptionLLMService.Settings({ reasoningEffort: "low" }),
});
```

## Runtimes

Bun, Node.js 22+, Deno and Cloudflare Workers: HTTP goes through `fetch`.

## Links

- Docs: [services](https://polvallverdu.github.io/pipedog/docs/services/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
