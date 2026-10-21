# @pipedog/perplexity

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1
  - @pipedog/openai@0.6.1

## 0.6.0

### Minor Changes

- [#33](https://github.com/polvallverdu/pipedog/pull/33) [`c18bd85`](https://github.com/polvallverdu/pipedog/commit/c18bd85c47b24a65405b3bbf42c6b46e295abb81) Thanks [@polvallverdu](https://github.com/polvallverdu)! - OpenAI-compatible LLM services, one small package per provider, each an `OpenAILLMService`
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

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0
  - @pipedog/openai@0.6.0
