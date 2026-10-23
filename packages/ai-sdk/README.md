# @pipedog/ai-sdk

[Vercel AI SDK](https://ai-sdk.dev) for pipedog: `AISDKLLMService` runs any AI SDK language model as
the pipeline's LLM service, so a bot can use every AI SDK provider: `@ai-sdk/openai`,
`@ai-sdk/google`, `@ai-sdk/anthropic`, `@ai-sdk/mistral`, `@ai-sdk/amazon-bedrock`, Ollama and the
community providers, or a model ID string through the AI Gateway. `AISDKLLMAdapter` converts the
universal `LLMContext` to the AI SDK's `ModelMessage`s and tools.

This is a pipedog addition; Pipecat (Python) has no counterpart.

## Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/ai-sdk ai zod @ai-sdk/google
```

`ai` (`^7.0.0`) is a peer dependency, and needs `zod`. Add the provider package you use.

## Usage

```ts
import { google } from "@ai-sdk/google";
import { AISDKLLMService } from "@pipedog/ai-sdk";

const llm = new AISDKLLMService({
  model: google("gemini-3.5-flash-lite"),
  settings: new AISDKLLMService.Settings({
    systemInstruction: "You are a helpful voice assistant. Keep replies short.",
    temperature: 0.7,
  }),
});
// new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), ...])
```

It drops into a pipeline wherever a native LLM service would, between the user context aggregator
and the TTS service, and behaves like one:

- It consumes `LLMContextFrame`s and pushes `LLMFullResponseStartFrame`, an `LLMTextFrame` per
  streamed delta, and `LLMFullResponseEndFrame`. Reasoning comes out as `LLMThought*Frame`s.
- Tools come from the context's `ToolsSchema`. They are sent without `execute`, so the AI SDK
  returns the model's tool calls and pipedog runs them (`registerFunction`, `FunctionSchema`
  handlers, direct functions), adds the results to the context and asks the model again.
  Provider-defined tools (Google Search, OpenAI web search, ...) go in the `tools` option.
- Interruptions abort the request. TTFB, processing time and token usage (with cached and
  reasoning tokens) are reported as metrics.
- Settings: `temperature`, `maxTokens`, `topP`, `topK`, `frequencyPenalty`, `presencePenalty`,
  `seed`, `stopSequences` and `providerOptions`, updatable at runtime with
  `LLMUpdateSettingsFrame`. Pass `provider` (e.g. `google`) to switch models by ID at runtime, or
  call `setLanguageModel()`.
- Provider metadata that has to come back on later turns (Gemini's thought signatures, Anthropic's
  thinking signatures) is kept in the context and sent back with its output.
- `runInference()` runs a one-shot `generateText()`, with `responseSchema` as `Output.object()`.

## Runtimes

| | Bun | Node | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `AISDKLLMService` | ✅ | ✅ | ✅ | ✅ |

The service uses no runtime-specific APIs. Whether a provider package runs on a given runtime is up
to that package; the official ones use `fetch`.

## Links

- Docs: [Vercel AI SDK](https://polvallverdu.github.io/pipedog/docs/services/llm/ai-sdk/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause. See [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE).
