# @pipedog/cli

The `pipedog` command: Pipecat's CLI (`pipecat.cli`) for pipedog.

- **`pipedog init`** scaffolds a TypeScript voice bot: a `bot.ts` on `@pipedog/runner` with the
  services you pick, a `package.json` with the right packages, `.env.example`, an optional Vite
  client, an optional Dockerfile, a README, and `AGENTS.md` / `CLAUDE.md` guides for coding
  agents. It registers the docs MCP server, `@pipedog/mcp`, for Claude Code, Cursor and VS Code
  (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`).
- **`pipedog eval`** runs [`@pipedog/evals`](../evals) (`run`, `judge`, `suite`), loaded when you
  use it: that package is an optional peer dependency, and the commands aren't duplicated.

```sh
bunx @pipedog/cli init                  # or: npx @pipedog/cli init
bunx @pipedog/cli init quickstart       # the canned bot: SmallWebRTC, Deepgram, OpenAI, Cartesia
bunx @pipedog/cli init my-bot -t smallwebrtc -m cascade \
  --stt deepgram_stt --llm openai_llm --tts cartesia_tts --eval
bunx @pipedog/cli init --list-options   # the values of every flag, as JSON
```

With flags (or `--config file.json`) `init` never prompts, so scripts and coding agents can run it;
`--dry-run` prints the resolved config. The guide: https://polvallverdu.github.io/pipedog/docs/cli/

## What it generates

```text
my-bot/
├── server/
│   ├── bot.ts           # export async function bot(runnerArgs); main({ bot })
│   ├── package.json     # @pipedog/* at this release, and what they need
│   ├── tsconfig.json
│   ├── .env.example
│   └── evals/           # with --eval
├── client/              # with --client-framework vanilla
├── AGENTS.md, CLAUDE.md
├── .mcp.json, .cursor/mcp.json, .vscode/mcp.json
└── README.md
```

Run it with `bun bot.ts` (or `node bot.ts` with `--runtime node`).

## The service registry

`src/service_metadata.ts` lists the services `init` offers, with their imports (`_imports.ts`) and
constructors (`_configs.ts`). The list covers what pipedog has ported and nothing else. Tests keep
it honest: they check every import against the workspace packages, compare it with the provider
catalog of the docs (`apps/docs/data/providers.ts`), and type-check a generated bot for every
service (`test/e2e.test.ts`).

## Runtimes

| | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `pipedog` | ✅ | ✅ (22 or later) | ✅ | ❌ a command line tool |

The generated projects run on Bun, or on Node 22.18 or later (`--runtime node`).

## Differences from upstream

- Only ported services are offered. There is no Daily (so no Daily PSTN or Twilio + Daily SIP),
  and none of Pipecat's unported services.
- No Pipecat Cloud (`--deploy-to-cloud`, `pcc-deploy.toml`), Krisp or `pipecat cloud` plugin; a plain
  Dockerfile is `--dockerfile`.
- One client, the vanilla JS one. The React clients (Vite, Next.js) aren't ported.
- The docs MCP server replaces the Context Hub: nothing to index, and no freshness check
  (`hub_status` is skipped).
- Cloudflare Workers has no template (see `examples/workers-durable-voice-agent`), and there is no
  `create-pipedog` alias: `npm create` and `bun create` look for a package of that name.
- `typer` and `rich` are `node:util`'s `parseArgs` and plain lines; `questionary` is
  `@clack/prompts`.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily). The client template under
`templates/` is Pipecat's vanilla JS client, with the same license.
