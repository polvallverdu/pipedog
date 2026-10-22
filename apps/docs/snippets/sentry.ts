// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/sentry-metrics.mdx. Type-checked on every docs build.
// `@sentry/core` stands in for the runtime SDK (@sentry/node, @sentry/bun, @sentry/deno,
// @sentry/cloudflare), which re-export the same functions.

import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";

// #region usage
import { OpenAILLMService } from "@pipedog/openai/llm";
import { SentryMetrics } from "@pipedog/sentry";
import * as Sentry from "@sentry/core";

// Sentry.init({ dsn, tracesSampleRate: 1.0 }) has already run, with the SDK for your runtime.

const llm = new OpenAILLMService({
  apiKey: process.env.OPENAI_API_KEY ?? null,
  // One SentryMetrics per processor: each tracks its own transactions.
  metrics: new SentryMetrics({ sentry: Sentry }),
});
// #endregion usage

// #region worker
// Sentry transactions are only started when metrics are enabled.
const worker = new PipelineWorker(new Pipeline([llm]), {
  params: new PipelineParams({ enableMetrics: true }),
});
// #endregion worker

void worker;
