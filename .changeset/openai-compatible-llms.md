---
"@pipedog/baseten": minor
"@pipedog/cerebras": minor
"@pipedog/crusoe": minor
"@pipedog/deepseek": minor
"@pipedog/fireworks": minor
"@pipedog/nebius": minor
"@pipedog/novita": minor
"@pipedog/ollama": minor
"@pipedog/openrouter": minor
"@pipedog/perplexity": minor
"@pipedog/qwen": minor
"@pipedog/sambanova": minor
---

OpenAI-compatible LLM services, one small package per provider, each an `OpenAILLMService`
subclass with the provider's base URL, default model and request quirks:

- `@pipedog/baseten` (`BasetenLLMService`), `@pipedog/cerebras` (`CerebrasLLMService`),
  `@pipedog/crusoe` (`CrusoeLLMService`), `@pipedog/fireworks` (`FireworksLLMService`),
  `@pipedog/nebius` (`NebiusLLMService`), `@pipedog/novita` (`NovitaLLMService`),
  `@pipedog/ollama` (`OLLamaLLMService`), `@pipedog/qwen` (`QwenLLMService`) and
  `@pipedog/sambanova` (`SambaNovaLLMService`).
- `@pipedog/deepseek`: `DeepSeekLLMService`, with thinking off by default
  (`DeepSeekThinkingConfig`), and `DeepSeekLLMAdapter`.
- `@pipedog/openrouter`: `OpenRouterLLMService`, with provider routing preferences
  (`OpenRouterProviderPreferences`).
- `@pipedog/perplexity`: `PerplexityLLMService` and `PerplexityLLMAdapter`, which rewrites the
  history to Perplexity's role rules.
