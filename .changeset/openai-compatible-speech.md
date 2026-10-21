---
"@pipedog/groq": minor
"@pipedog/mistral": minor
"@pipedog/together": minor
"@pipedog/xai": minor
"@pipedog/grok": minor
---

OpenAI-compatible providers with speech services, one package each:

- `@pipedog/groq`: `GroqLLMService` (with `reasoningEffort`), `GroqSTTService` (Whisper models) and
  `GroqTTSService`.
- `@pipedog/mistral`: `MistralLLMService` and `MistralLLMAdapter`, `MistralSTTService` (Voxtral
  realtime) and `MistralTTSService` (Voxtral TTS).
- `@pipedog/together`: `TogetherLLMService` (with a `reasoning` toggle), `TogetherSTTService` and
  `TogetherTTSService`, over WebSockets.
- `@pipedog/xai`: `GrokLLMService` (with `reasoningEffort`), `XAISTTService`, and `XAITTSService`
  (WebSocket, word timestamps) and `XAIHttpTTSService`.
- `@pipedog/grok`: the deprecated alias of `@pipedog/xai/llm`.
