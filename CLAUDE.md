# pipedog

Unofficial TypeScript port of Pipecat (Python, BSD-2-Clause, by Daily). Bun monorepo.

- Upstream source, pinned: `.upstream/pipecat` (commit in `upstream.json`; `bun run upstream` restores it).
- Porting rules: `docs/CONVENTIONS.md`. Read it before porting or reviewing anything.
- Porting state: `porting/manifest.json` (machine) and `porting/STATUS.md` (generated). Change status
  with `bun tools/port/status.ts --set <module|test> <status> [notes]`, never by hand-editing.
- Next work: `bun tools/port/next.ts modules|tests ...`. Batch porting: the `port` workflow
  (`.claude/workflows/port.js`), e.g. args `{ "select": "--package @pipedog/deepgram" }`.
- Checks: `bun test`, `bun run typecheck`, `bun run lint` (biome + license headers).
- Core must stay runtime-agnostic (Bun, Node, Deno, Cloudflare Workers): no `node:*` imports, no
  `Buffer`, no Bun APIs in `packages/core` or `packages/asyncio`.
- Cancellation: every broad `catch` in ported code begins with `rethrowIfCancelled(e)`.
