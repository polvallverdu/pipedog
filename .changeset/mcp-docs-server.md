---
"@pipedog/mcp": minor
---

`@pipedog/mcp`: a local stdio MCP server with the pipedog docs, for coding agents.

- Tools: `list_pages`, `search_docs` (BM25 over page sections), `read_page` and `get_api` (an
  exported class or function's import path, constructor, options interface and declaration, from
  the packages' `.d.ts`). Every page is also a `pipedog://docs/<slug>` resource.
- Each release bundles the docs and API of that release, so it works offline and matches the
  installed pipedog version. `--live` reads the current docs from the site instead, with a timeout
  and a fallback to the bundled docs.
- `claude mcp add pipedog -- npx -y @pipedog/mcp`. Runs on Node.js 20+.
