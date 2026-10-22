# @pipedog/sentry

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#55](https://github.com/polvallverdu/pipedog/pull/55) [`97aecf8`](https://github.com/polvallverdu/pipedog/commit/97aecf815fa5b0b36b34d9ad9bb8c1044d5844b7) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add `@pipedog/extensions` and `@pipedog/sentry`:
  
  - `@pipedog/extensions`: ports of `pipecat.extensions`. `IVRNavigator` and `IVRProcessor` let an LLM navigate phone menus with DTMF; `VoicemailDetector` and `TTSGate` tell a person from a voicemail on outbound calls. Pure logic, on Bun, Node, Deno and Cloudflare Workers. The deprecated `llm` and `customSystemPrompt` parameters of `VoicemailDetector` are not ported.
  - `@pipedog/sentry`: `SentryMetrics`, a port of `pipecat.processors.metrics.sentry`. It takes the Sentry SDK for your runtime (`@sentry/node`, `@sentry/bun`, `@sentry/deno`, `@sentry/cloudflare`) as an option, behind a three-method interface, and reports TTFB and processing time as Sentry transactions.

### Patch Changes

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
