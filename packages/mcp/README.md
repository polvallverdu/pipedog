# @pipedog/mcp

A local [MCP](https://modelcontextprotocol.io) server with the pipedog docs, for coding agents
(Claude Code, Cursor, VS Code, Windsurf and any other MCP client). It runs over stdio and gives the
agent the docs of the pipedog version it came with, and the API of every `@pipedog/*` package.

Not a port of an upstream module: Pipecat has no counterpart.

## Install

Nothing to install in your project: the agent starts it with `npx`.

```sh
claude mcp add pipedog -- npx -y @pipedog/mcp
```

Cursor (`.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`) and other clients
that use `mcpServers`:

```json
{
  "mcpServers": {
    "pipedog": { "command": "npx", "args": ["-y", "@pipedog/mcp"] }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "pipedog": { "type": "stdio", "command": "npx", "args": ["-y", "@pipedog/mcp"] }
  }
}
```

`bunx @pipedog/mcp` works too.

## Tools

| Tool | What it does |
|---|---|
| `list_pages(section?)` | Every page's slug, title and description, by section (`Services`, `Speech-to-text` or `services/stt`). |
| `search_docs(query, limit?)` | Keyword search (BM25) over page sections: slug, title, heading and a snippet. |
| `read_page(slug)` | A page's full Markdown, e.g. `services/stt/deepgram`. |
| `get_api(symbol)` | An exported class, function or type: import path, constructor, options interface and declaration, from the packages' `.d.ts`. |

Each page is also a resource, `pipedog://docs/<slug>`, and the index is `pipedog://llms.txt`.

## Offline by default, live on request

Each release bundles the docs (llms.txt and every page's Markdown, from the docs build) and the
API (every exported declaration of the packages' `.d.ts`) of that release. Every `@pipedog/*`
package is released at one version, so `@pipedog/mcp@<version>` describes pipedog `<version>`.

| Option | Environment variable | |
|---|---|---|
| `--live` | `PIPEDOG_MCP_LIVE=1` | Read the current docs from the site; falls back to the bundled ones. |
| `--docs-url <url>` | `PIPEDOG_DOCS_URL` | The site for `--live` (default `https://polvallverdu.github.io/pipedog`). |
| `--timeout <ms>` | `PIPEDOG_MCP_TIMEOUT_MS` | How long `--live` waits (default 10000). |
| `--snapshot <file>` | `PIPEDOG_MCP_SNAPSHOT` | A docs snapshot other than the bundled one. |

## Runtimes

Node.js 20+ (and Bun). It is a command-line server, not a library for Deno or Workers.

## Development

The snapshot (`snapshot/docs.json`) is not committed. `bun run release` writes it after the
package build, with `bun run mcp:snapshot --build` (a docs build for the production URL, then the
snapshot). `bun run mcp:snapshot` alone uses the existing `apps/docs/out` and `packages/*/dist`.
The tests make their own snapshot, building the docs first if needed.

## Links

- Docs: [docs for AI tools](https://polvallverdu.github.io/pipedog/docs/guides/llms/)
- [pipedog README](https://github.com/polvallverdu/pipedog#readme)
- License: BSD 2-Clause, part of pipedog, a port of Pipecat (Copyright (c) 2024–2026 Daily). See
  [LICENSE](https://github.com/polvallverdu/pipedog/blob/main/LICENSE). The bundled docs are
  adapted in part from the [Pipecat documentation](https://github.com/pipecat-ai/docs)
  (BSD-2-Clause).
