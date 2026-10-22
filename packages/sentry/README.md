# @pipedog/sentry

`SentryMetrics` for pipedog, a port of `pipecat.processors.metrics.sentry`. It reports a service's
TTFB and processing time to Sentry as transactions (`op` `ttfb` and `processing`), alongside the
normal `MetricsFrame`s.

```sh
bun add @pipedog/sentry
bun add @sentry/node   # or @sentry/bun, @sentry/deno, @sentry/cloudflare
```

It depends on no Sentry package: you pass the SDK namespace of your runtime, and it uses only
`isInitialized()`, `startInactiveSpan()` and `flush()`.

```ts
import * as Sentry from "@sentry/node";
import { SentryMetrics } from "@pipedog/sentry";

Sentry.init({ dsn: "...", tracesSampleRate: 1.0, traceLifecycle: "static" });

const llm = new OpenAILLMService({ metrics: new SentryMetrics({ sentry: Sentry }) });
// PipelineParams({ enableMetrics: true })
```

## Runtimes

| | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `SentryMetrics` | ✅ | ✅ | ✅ | ✅ |

Verified with `@sentry/core` (which every Sentry JS SDK re-exports) and a recording transport. On
Workers, `@sentry/cloudflare` needs the Worker wrapped with `withSentry` or its Vite plugin; create
`SentryMetrics` inside the request. Not run against Sentry's servers or the platform SDKs.

See [Sentry metrics](https://polvallverdu.github.io/pipedog/docs/concepts/sentry-metrics/) for
the Workers details and the differences from upstream (`traceLifecycle: "static"`, the SDK passed in).

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
