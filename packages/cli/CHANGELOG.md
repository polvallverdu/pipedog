# @pipedog/cli

## 0.10.0

### Patch Changes

- Updated dependencies []:
  - @pipedog/evals@0.10.0

## 0.9.0

### Minor Changes

- [#74](https://github.com/polvallverdu/pipedog/pull/74) [`b6a2619`](https://github.com/polvallverdu/pipedog/commit/b6a26198124201b5c53a10db6861373daa81b748) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New package `@pipedog/ai-sdk`: `AISDKLLMService` runs any Vercel AI SDK language model (`ai` 7: `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/anthropic`, Ollama and community providers, or AI Gateway model IDs) as the pipeline's LLM service.
  
  It behaves like pipedog's native LLM services: it streams `LLMTextFrame`s between `LLMFullResponseStartFrame` and `LLMFullResponseEndFrame`, sends the context's `ToolsSchema` as AI SDK tools without `execute` so pipedog's function calling runs them, aborts the request on interruptions, and reports TTFB, processing and token usage metrics. `AISDKLLMAdapter` converts the context (system instruction, images, files, audio, tool calls and results, reasoning) to AI SDK messages, and keeps provider metadata such as Gemini thought signatures across turns. `ai` is a peer dependency. Runs on Bun, Node, Deno and Cloudflare Workers.
  
  `pipedog init` offers it as the "Vercel AI SDK" LLM, with an AI Gateway model ID.

### Patch Changes

- [#78](https://github.com/polvallverdu/pipedog/pull/78) [`5b7f383`](https://github.com/polvallverdu/pipedog/commit/5b7f3838f90e677c7ea23dcbdd52605bd3084c19) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New package `@pipedog/cloudflare`: Cloudflare Workers AI services, over the Worker's `AI` binding or the REST API. Deepgram Flux (`WorkersAIFluxSTTService`, with turn detection), Nova-3 (`WorkersAINova3STTService`) and Whisper (`WorkersAIWhisperSTTService`) speech-to-text; Aura (`WorkersAIAuraTTSService` over a WebSocket, `WorkersAIAuraHttpTTSService`) and MeloTTS (`WorkersAIMeloTTSService`) text-to-speech; `WorkersAILLMService` on the OpenAI-compatible endpoint; and `WorkersAISmartTurnAnalyzer` for Smart Turn v2. `pipedog init` offers the Flux, Whisper, Aura and LLM services.
- Updated dependencies []:
  - @pipedog/evals@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies []:
  - @pipedog/evals@0.8.0

## 0.7.0

### Minor Changes

- [#61](https://github.com/polvallverdu/pipedog/pull/61) [`d1b0f51`](https://github.com/polvallverdu/pipedog/commit/d1b0f512c5cb7627ec84676abde2116c3508a440) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add `@pipedog/cli`, the port of Pipecat's CLI, as the `pipedog` command (`bunx @pipedog/cli init`, `npx @pipedog/cli init`):
  
  - `pipedog init` scaffolds a TypeScript voice bot on `@pipedog/runner`: `bot.ts`, `package.json`, `.env.example`, a README, an optional Vite client, an optional Dockerfile and a starter eval scenario. It runs interactively, from flags (`--dry-run`, `--list-options`) or from a config file, on Bun or Node (`--runtime`), and the generated project type-checks against the real packages.
  - The service registry offers the speech, LLM, realtime and video services and transports that pipedog has ported, and nothing else. Tests compare it with the docs' provider catalog and the workspace packages.
  - `init` writes `AGENTS.md`, `CLAUDE.md` and `GETTING_STARTED.md` for coding agents, and registers the docs MCP server, `@pipedog/mcp`, for Claude Code, Cursor and VS Code.
  - `pipedog eval` runs the commands of `@pipedog/evals` (an optional peer dependency).
  
  Not ported: the Context Hub's freshness check, Daily and Pipecat Cloud flags and the React clients.

### Patch Changes

- Updated dependencies [[`fb25ede`](https://github.com/polvallverdu/pipedog/commit/fb25edef3cb316a0581579de92ee4b3a17495d46), [`41278ae`](https://github.com/polvallverdu/pipedog/commit/41278ae4842de3534561ca725d18621c3fb27e8a)]:
  - @pipedog/evals@0.7.0
