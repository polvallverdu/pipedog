# @pipedog/ai-sdk

## 0.9.0

### Minor Changes

- [#74](https://github.com/polvallverdu/pipedog/pull/74) [`b6a2619`](https://github.com/polvallverdu/pipedog/commit/b6a26198124201b5c53a10db6861373daa81b748) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New package `@pipedog/ai-sdk`: `AISDKLLMService` runs any Vercel AI SDK language model (`ai` 7: `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/anthropic`, Ollama and community providers, or AI Gateway model IDs) as the pipeline's LLM service.
  
  It behaves like pipedog's native LLM services: it streams `LLMTextFrame`s between `LLMFullResponseStartFrame` and `LLMFullResponseEndFrame`, sends the context's `ToolsSchema` as AI SDK tools without `execute` so pipedog's function calling runs them, aborts the request on interruptions, and reports TTFB, processing and token usage metrics. `AISDKLLMAdapter` converts the context (system instruction, images, files, audio, tool calls and results, reasoning) to AI SDK messages, and keeps provider metadata such as Gemini thought signatures across turns. `ai` is a peer dependency. Runs on Bun, Node, Deno and Cloudflare Workers.
  
  `pipedog init` offers it as the "Vercel AI SDK" LLM, with an AI Gateway model ID.

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/asyncio@0.9.0
