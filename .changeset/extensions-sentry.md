---
"@pipedog/extensions": minor
"@pipedog/sentry": minor
---

Add `@pipedog/extensions` and `@pipedog/sentry`:

- `@pipedog/extensions`: ports of `pipecat.extensions`. `IVRNavigator` and `IVRProcessor` let an LLM navigate phone menus with DTMF; `VoicemailDetector` and `TTSGate` tell a person from a voicemail on outbound calls. Pure logic, on Bun, Node, Deno and Cloudflare Workers. The deprecated `llm` and `customSystemPrompt` parameters of `VoicemailDetector` are not ported.
- `@pipedog/sentry`: `SentryMetrics`, a port of `pipecat.processors.metrics.sentry`. It takes the Sentry SDK for your runtime (`@sentry/node`, `@sentry/bun`, `@sentry/deno`, `@sentry/cloudflare`) as an option, behind a three-method interface, and reports TTFB and processing time as Sentry transactions.
