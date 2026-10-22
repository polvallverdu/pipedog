---
"@pipedog/ai-sdk": minor
"@pipedog/cli": minor
---

New package `@pipedog/ai-sdk`: `AISDKLLMService` runs any Vercel AI SDK language model (`ai` 7: `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/anthropic`, Ollama and community providers, or AI Gateway model IDs) as the pipeline's LLM service.

It behaves like pipedog's native LLM services: it streams `LLMTextFrame`s between `LLMFullResponseStartFrame` and `LLMFullResponseEndFrame`, sends the context's `ToolsSchema` as AI SDK tools without `execute` so pipedog's function calling runs them, aborts the request on interruptions, and reports TTFB, processing and token usage metrics. `AISDKLLMAdapter` converts the context (system instruction, images, files, audio, tool calls and results, reasoning) to AI SDK messages, and keeps provider metadata such as Gemini thought signatures across turns. `ai` is a peer dependency. Runs on Bun, Node, Deno and Cloudflare Workers.

`pipedog init` offers it as the "Vercel AI SDK" LLM, with an AI Gateway model ID.
