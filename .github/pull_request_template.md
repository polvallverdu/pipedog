## What

<!-- What this changes, and why. Link the issue it fixes, if any. -->

## Upstream

<!-- For ported code: the upstream module(s) and tests, and any DIVERGENCE from upstream behavior. -->

## Checklist

- [ ] `bun run typecheck`, `bun run lint` and the affected packages' tests (`bun test packages/<name>`) pass
- [ ] Ported code follows [docs/CONVENTIONS.md](https://github.com/polvallverdu/pipedog/blob/main/docs/CONVENTIONS.md): license headers, options objects, `rethrowIfCancelled` in broad catches
- [ ] Porting status updated with `bun tools/port/status.ts --set ...` (not hand-edited), if modules or tests were ported
- [ ] A changeset (`bun changeset`), if a published package changed
- [ ] Docs updated, if behavior or the public API changed
