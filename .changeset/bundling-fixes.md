---
"@pipedog/audio-silero": patch
"@pipedog/audio-smart-turn": patch
"@pipedog/audio-rnnoise-filter": patch
"@pipedog/transport-smallwebrtc": patch
"@pipedog/runner": patch
"@pipedog/core": patch
---

Fixes for apps bundled with `bun build` (and `bun build --compile`) and run without `node_modules`:

- `@pipedog/transport-smallwebrtc` loads `reflect-metadata` first itself (a new dependency, pinned). werift's X.509 code needs it before `tsyringe`, and a bundle that loads the transport lazily, as `@pipedog/runner` does, could put the import after it, which disabled the runner's WebRTC routes. Hosts don't import or externalize `reflect-metadata`; it does not belong in core.
- `@pipedog/runner` counts its own transports (`@pipedog/transport-websocket`, `@pipedog/transport-smallwebrtc`) as available instead of resolving them by name, which fails in a bundle: every telephony and WebSocket route answered 404.
- Silero, Smart Turn and RNNoise read their default model or `.wasm` file next to the package's source, which a bundle does not copy. The error now names the `model` option (or `initRnnoise()`) and the `with { type: "file" }` import that fixes it, instead of a bare file-not-found for a path nobody recognizes.
- Core's Smart Turn fallback warning says that a bundled app has to pass `createLocalSmartTurnAnalyzerV3()` to the turn strategy, since a bundler can't see core's by-name import.

Docs: a Bundling page under Deployment, with the tested `bun build` recipe, a snippet per asset, and what has to stay outside the bundle and why. `examples/bundle-check` bundles and runs a sample bot per configuration in CI.
