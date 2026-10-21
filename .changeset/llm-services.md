---
"@pipedog/openai": minor
"@pipedog/anthropic": minor
"@pipedog/whisper": minor
"@pipedog/google": minor
---

LLM services: OpenAI, Anthropic, and the rest of Google.

- `@pipedog/openai`: `OpenAILLMService`, `OpenAIResponsesLLMService`, `OpenAIRealtimeLLMService`,
  `OpenAILiveLLMService`, `OpenAISTTService`, `OpenAITTSService`, `OpenAIImageGenService`, and the
  matching adapters.
- `@pipedog/anthropic`: `AnthropicLLMService` and `AnthropicLLMAdapter`, with prompt caching and
  extended thinking, on `@anthropic-ai/sdk`.
- `@pipedog/whisper`: `BaseWhisperSTTService`, the base class `OpenAISTTService` builds on.
- `@pipedog/google`: `GoogleLLMService`, `GoogleVertexLLMService`, `GeminiLiveLLMService`,
  `GeminiLiveVertexLLMService`, `GeminiSTTService`, `GeminiTTSService`, `GoogleImageGenService`,
  `GeminiFileAPI`, and `GoogleRTVIProcessor` / `GoogleRTVIObserver`.
