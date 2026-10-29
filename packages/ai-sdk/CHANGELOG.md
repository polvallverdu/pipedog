# @pipedog/ai-sdk

## 0.11.0

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Minor Changes

- [#74](https://github.com/polvallverdu/pipedog/pull/74) [`b6a2619`](https://github.com/polvallverdu/pipedog/commit/b6a26198124201b5c53a10db6861373daa81b748) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New package `@pipedog/ai-sdk`: `AISDKLLMService` runs any Vercel AI SDK language model (`ai` 7: `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/anthropic`, Ollama and community providers, or AI Gateway model IDs) as the pipeline's LLM service.
  
  It behaves like pipedog's native LLM services: it streams `LLMTextFrame`s between `LLMFullResponseStartFrame` and `LLMFullResponseEndFrame`, sends the context's `ToolsSchema` as AI SDK tools without `execute` so pipedog's function calling runs them, aborts the request on interruptions, and reports TTFB, processing and token usage metrics. `AISDKLLMAdapter` converts the context (system instruction, images, files, audio, tool calls and results, reasoning) to AI SDK messages, and keeps provider metadata such as Gemini thought signatures across turns. `ai` is a peer dependency. Runs on Bun, Node, Deno and Cloudflare Workers.
  
  `pipedog init` offers it as the "Vercel AI SDK" LLM, with an AI Gateway model ID.

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/asyncio@0.9.0
