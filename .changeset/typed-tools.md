---
"@pipedog/core": minor
---

Add `defineTool` (`@pipedog/core/adapters/schemas/standard_tool`): typed function-calling tools from any Standard Schema (Zod, Valibot, ArkType). The JSON schema comes from Standard JSON Schema (`~standard.jsonSchema`) or an explicit `jsonSchema`, the handler's `args` are inferred, and arguments are validated before the handler runs; invalid arguments are returned to the LLM as the result. It returns a regular `FunctionSchema`, so existing APIs are unchanged. Also adds `registerTools` and the copied Standard Schema interfaces in `@pipedog/core/utils/standard_schema`.
