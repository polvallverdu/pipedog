# @pipedog/cli

## 0.11.0

### Minor Changes

- [#104](https://github.com/polvallverdu/pipedog/pull/104) [`34d7530`](https://github.com/polvallverdu/pipedog/commit/34d7530ae607e20db11114b1a5d981bbeb71fa88) Thanks [@polvallverdu](https://github.com/polvallverdu)! - LLM and other providers brought up to pipecat main after 1.14:
  
  - ⚠️ Perplexity: `PerplexityLLMService` (Sonar chat completions) is removed, as upstream deprecates
    it; use the new `PerplexityAgentHttpLLMService` for Perplexity's Agent API, with `preset`,
    `webSearch` and `maxSteps` settings ([#5985](https://github.com/polvallverdu/pipedog/issues/5985)).
  - New `SmallestLLMService` (Smallest's Electron models, OpenAI-compatible, [#6339](https://github.com/polvallverdu/pipedog/issues/6339)).
  - OpenAI: Responses services report an empty completion and default `gpt-6.1-terra` to no
    reasoning ([#6348](https://github.com/polvallverdu/pipedog/issues/6348), [#6434](https://github.com/polvallverdu/pipedog/issues/6434)); the realtime client tolerates unknown server events ([#6329](https://github.com/polvallverdu/pipedog/issues/6329)); image
    generation takes `moderation` ([#6432](https://github.com/polvallverdu/pipedog/issues/6432)).
  - AWS Bedrock: reasoning is pushed as thought frames and round-trips with its signature, and Nova's
    `<thinking>` text no longer reaches TTS ([#6229](https://github.com/polvallverdu/pipedog/issues/6229)).
  - Azure realtime authenticates through the `_authHeaders()` hook ([#6329](https://github.com/polvallverdu/pipedog/issues/6329)).
  - Together: `reasoningEffort` ([#6437](https://github.com/polvallverdu/pipedog/issues/6437)). Inception defaults to `mercury-3` ([#6397](https://github.com/polvallverdu/pipedog/issues/6397)).
  - Twilio: `apiKeySid` / `apiKeySecret` as an alternative to `authToken` for auto hang-up; the
    runner reads `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_REGION` and `TWILIO_EDGE` ([#6270](https://github.com/polvallverdu/pipedog/issues/6270),
    [#6293](https://github.com/polvallverdu/pipedog/issues/6293)).
  - Evals: `text_matches` expectations (failure kind `text_unmatched`, [#5991](https://github.com/polvallverdu/pipedog/issues/5991)) and the `expression`
    event ([#6303](https://github.com/polvallverdu/pipedog/issues/6303)); image requests with no registered image get an error answer ([#6350](https://github.com/polvallverdu/pipedog/issues/6350)).
  - CLI: the Perplexity entry uses `PerplexityAgentHttpLLMService`.

- [#105](https://github.com/polvallverdu/pipedog/pull/105) [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2) Thanks [@polvallverdu](https://github.com/polvallverdu)! - New providers from pipecat main after 1.14:
  
  - `@pipedog/nvidia` (new): `NvidiaLLMService` (NVIDIA NIM, OpenAI-compatible, with reasoning
    content and `<think>` handling) and `NvidiaOmniLLMService` (Nemotron Omni: audio understanding
    and the user's turn in one request, `NvidiaOmniLLMAdapter`, `runMultimodalInference()`,
    pipecat-ai/pipecat#6085). Riva STT/TTS are not ported yet.
  - `@pipedog/zoom-ai` (new): `ZoomAISTTService`, Zoom's Scribe streaming STT ([#6280](https://github.com/polvallverdu/pipedog/issues/6280)).
  - `@pipedog/assemblyai`: `AssemblyAITTSService`, streaming TTS with per-word timings ([#6322](https://github.com/polvallverdu/pipedog/issues/6322)).
  - Pipecat Tone for expressive conversation (alpha): the `PipecatToneReader` and
    `PipecatToneTagger` processors in `@pipedog/core/processors/tone`, with their ONNX models in the
    new `@pipedog/tone` (on `@pipedog/onnx`; [#6319](https://github.com/polvallverdu/pipedog/issues/6319), [#6385](https://github.com/polvallverdu/pipedog/issues/6385), [#6407](https://github.com/polvallverdu/pipedog/issues/6407)).
  - The CLI offers Zoom AI STT, AssemblyAI TTS and the NVIDIA LLM.

### Patch Changes

- Updated dependencies [[`34d7530`](https://github.com/polvallverdu/pipedog/commit/34d7530ae607e20db11114b1a5d981bbeb71fa88)]:
  - @pipedog/evals@0.11.0

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
