# Contributing to pipedog

Thanks for helping. pipedog is an unofficial TypeScript port of
[Pipecat](https://github.com/pipecat-ai/pipecat), so most work is one of: porting an upstream module
or test, fixing a divergence from upstream behavior, or making something run on another runtime.
Bug reports from real use (especially against live providers) are just as valuable.

## Prerequisites

- **Bun 1.4.3.** That is the version CI uses (`.github/actions/setup/action.yml`); the root
  `package.json` does not pin one with `packageManager` or `engines`, so use 1.4.3 or newer.
- **Node.js 22 or later** and **Deno 2.x**, optional. You only need them to run the runtime
  compatibility harness (`bun run compat`) locally. CI uses Node 24.
- **Python 3**, optional. Only for `bun run port:plan`, which rebuilds the porting manifest from the
  upstream checkout.
- **Chromium for Playwright**, optional. Only for the `examples/smallwebrtc-voice-bot` browser test
  (`bunx playwright-core install chromium` in that directory); without it, the test is skipped.

## Setup

```sh
git clone https://github.com/polvallverdu/pipedog.git
cd pipedog
bun install
bun run upstream     # check out the pinned Pipecat commit into .upstream/pipecat (for porting)
```

## Checks and tests

These are the scripts in the root `package.json`, and what CI runs (`.github/workflows/ci.yml`):

| Command | What | CI job |
| --- | --- | --- |
| `bun run typecheck` | `tsc -b` over every package and example | `checks` |
| `bun run lint` | `biome check .` plus the license-header check (`tools/port/check-headers.ts`) | `checks` |
| `bun run format` | `biome format --write .` (fixes formatting) | |
| `bun test` | every test in the repository | |
| `bun test packages/<name>` | one package's tests | `packages` matrix |
| `bun run compat` | smoke tests on Bun, Node, Deno and workerd; `--write` records the results | `compat` |
| `bun run release:verify` | release rehearsal: pack, install from tarballs, import from Node | `release-verify` |
| `bun run docs:build` | build the docs site (and type-check its code samples) | `docs` |

CI runs tests per package: a `plan` job lists every `packages/*` and `examples/*` directory with
`test/**/*.test.ts`, and the `packages` matrix runs `bun test <dir>` for each one. To reproduce one
matrix entry locally:

```sh
bun test packages/core
bun test examples/smallwebrtc-voice-bot
```

Tests that need real API keys or network are skipped by default, as upstream does.

## Repository layout

| Path | What |
| --- | --- |
| `packages/core`, `packages/asyncio` | The runtime-agnostic core and asyncio semantics. No `node:*` imports, no `Buffer`, no Bun APIs. |
| `packages/<name>` | One package per provider, transport, serializer or audio model. |
| `examples/` | Runnable examples, each with its own tests. |
| `apps/docs` | The documentation site (Fumadocs on Next.js). |
| `docs/CONVENTIONS.md` | How Python maps to TypeScript. Read it before porting or reviewing. |
| `porting/` | `manifest.json` (every upstream module and test, with status) and the generated `STATUS.md`. |
| `tools/port/` | Dependency graph, work selection, status updates, license-header check. |
| `tools/compat/` | Runtime compatibility harness. |
| `tools/release/` | Release preparation and verification. |
| `upstream.json` | The pinned upstream repository and commit. |
| `.changeset/` | Pending changesets. |

## Porting workflow

pipedog is ported from one pinned upstream commit (`upstream.json`), module by module and test by
test. In short:

1. Pick work: `bun tools/port/next.ts modules ...` or `bun tools/port/next.ts tests ...`.
2. Port the module to its manifest `ts` path (same path and snake_case name as upstream), following
   [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).
3. Port its upstream tests 1:1, without weakening any assertion.
4. Record the status with `bun tools/port/status.ts --set <module|test> <status> [notes]`. Never
   hand-edit `porting/manifest.json` or `porting/STATUS.md`; `bun run port:status` regenerates
   `STATUS.md`.
5. To move to a newer upstream commit: `bun run upstream bump [ref]`.

The full process, including the batch `port` workflow for agents, is in the
[porting workflow docs](https://polvallverdu.github.io/pipedog/docs/contributing/).

## Coding conventions

[`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) is the rulebook. The points reviewers check most:

- **License headers.** Every file starts with the BSD-2-Clause header. Ported files carry both the
  Daily and the pipedog contributors copyright lines and a `Ported from pipecat: <path>` line; files
  with no upstream counterpart carry only the pipedog line. `bun run lint` checks this.
- **Options-object constructors.** Python keyword arguments become one options object
  (`<Class>Options`, extending the parent's and passed whole to `super(options)`). Required positional
  parameters of functions stay positional.
- **camelCase members.** Class names, module paths, event names (`"on_client_connected"`) and wire
  formats stay exactly as upstream; methods and attributes become camelCase.
- **Cancellation.** Every broad `catch` begins with `rethrowIfCancelled(e)` (from
  `@pipedog/asyncio`), so a cancellation is never swallowed.
- **Divergences.** Where behavior must differ from upstream, say so in a `DIVERGENCE:` comment
  (and, for a skipped test, list it in the manifest).
- **Dependencies.** Pin new dev dependencies exactly, to a version published at least 14 days ago
  (`npm view <pkg> time`), and check it resolves in `bun.lock`. Keep `@pipedog/core` free of new
  runtime dependencies; native, ML and runtime-specific code goes in its own package.

## Changesets

Every PR that changes a published package adds a changeset: run `bun changeset`, pick the bump and
write the changelog line. All `@pipedog/*` packages are one **fixed** group, so any release bumps
every package to the same version.

Docs-only, CI-only or example-only changes need no changeset. CI only warns when one is missing.
Merging to `main` keeps a "Version Packages" PR up to date; merging that PR publishes the release.

## Pull requests

- `main` is protected. Changes land through pull requests only.
- The `test` check must pass. It is one job that succeeds only when every other CI job did
  (typecheck, lint, the per-package tests, compat, release rehearsal, docs build).
- Branches must be up to date with `main`, and history is linear. Rebase on `origin/main` rather
  than merging it in.
- PRs are squash-merged, so the PR title becomes the commit message. Make it descriptive.
- Review threads must be resolved before merging.

## Docs site

The docs live in `apps/docs` (Fumadocs on Next.js); pages are MDX under `apps/docs/content/docs`.
Code samples live in `apps/docs/snippets` and are type-checked against the real sources on every
build.

```sh
bun run docs:dev     # http://localhost:3000
bun run docs:build   # what CI runs
```

Merges to `main` deploy the site to <https://polvallverdu.github.io/pipedog/>.

## Reporting bugs

Open an issue with the bug report form: <https://github.com/polvallverdu/pipedog/issues/new/choose>.
Include the runtime and version, the pipedog version, a minimal reproduction, and, if you can, how
upstream Pipecat behaves in the same case.

Report security vulnerabilities privately, not in an issue: see [SECURITY.md](SECURITY.md).

By taking part, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
