---
"@pipedog/core": minor
---

The LLM adapters moved to `adapters/llm`, as in pipecat 1.14 (pipecat-ai/pipecat#6331):
`@pipedog/core/adapters/base_llm_adapter` is now `@pipedog/core/adapters/llm/base_llm_adapter`,
`adapters/schemas/*` is `adapters/llm/schemas/*` (including `standard_tool`), and
`adapters/services/open_ai_adapter` is `adapters/llm/services/open_ai_adapter`. Upstream keeps the
old paths as deprecated shims; pipedog doesn't port deprecated APIs, so update the imports. Provider
adapters (`@pipedog/anthropic/anthropic_adapter`, ...) keep their paths.
