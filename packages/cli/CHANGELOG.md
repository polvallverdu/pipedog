# @pipedog/cli

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
