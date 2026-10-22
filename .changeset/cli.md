---
"@pipedog/cli": minor
---

Add `@pipedog/cli`, the port of Pipecat's CLI, as the `pipedog` command (`bunx @pipedog/cli init`, `npx @pipedog/cli init`):

- `pipedog init` scaffolds a TypeScript voice bot on `@pipedog/runner`: `bot.ts`, `package.json`, `.env.example`, a README, an optional Vite client, an optional Dockerfile and a starter eval scenario. It runs interactively, from flags (`--dry-run`, `--list-options`) or from a config file, on Bun or Node (`--runtime`), and the generated project type-checks against the real packages.
- The service registry offers the speech, LLM, realtime and video services and transports that pipedog has ported, and nothing else. Tests compare it with the docs' provider catalog and the workspace packages.
- `init` writes `AGENTS.md`, `CLAUDE.md` and `GETTING_STARTED.md` for coding agents, and registers the docs MCP server, `@pipedog/mcp`, for Claude Code, Cursor and VS Code.
- `pipedog eval` runs the commands of `@pipedog/evals` (an optional peer dependency).

Not ported: the Context Hub's freshness check, Daily and Pipecat Cloud flags and the React clients.
