---
"@pipedog/flows": minor
"@pipedog/google": patch
---

Add `@pipedog/flows`, a port of Pipecat Flows: nodes, direct functions, actions, context strategies, YAML/JSON flow configs (`FlowConfig`, `Flow`) and `FlowManager`, with docs and end-to-end tests on OpenAI, Anthropic and Google. `@pipedog/google` now sends tools to Gemini in the form the JS SDK reads (`functionDeclarations`); before, function calling offered the model no tools.
