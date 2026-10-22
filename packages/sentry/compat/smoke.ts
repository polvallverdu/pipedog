// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat: SentryMetrics against the real
// @sentry/core tracing functions (the ones every Sentry JS SDK re-exports,
// @sentry/cloudflare included), with a client whose transport records the
// envelopes. Transactions must come out with the right names and ops.

import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";
import * as Sentry from "@sentry/core";

import { type SentryClient, SentryMetrics } from "../src/sentry.ts";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`sentry smoke: ${message}`);
}

const sentry: SentryClient = Sentry;

export default async function smoke(): Promise<void> {
  logger.setLevel("CRITICAL");

  const envelopes: [unknown, [{ type: string }, any][]][] = [];
  Sentry.initAndBind(
    Sentry.Client as never,
    {
      dsn: "https://public@example.invalid/1",
      tracesSampleRate: 1.0,
      traceLifecycle: "static",
      integrations: [],
      stackParser: () => [],
      transport: () => ({
        send: async (envelope: (typeof envelopes)[number]) => {
          envelopes.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    } as never,
  );
  check(sentry.isInitialized(), "client not initialized");

  const metrics = new SentryMetrics({ sentry });
  metrics.setProcessorName("SmokeTTS");
  await metrics.setup(new TaskManager());
  await metrics.startTtfbMetrics({ reportOnlyInitialTtfb: false });
  check((await metrics.stopTtfbMetrics()) !== null, "no TTFB metrics frame");
  await metrics.startProcessingMetrics();
  check((await metrics.stopProcessingMetrics()) !== null, "no processing metrics frame");
  await metrics.cleanup();

  const transactions = envelopes
    .flatMap((envelope) => envelope[1])
    .filter(([header]) => header.type === "transaction")
    .map(([, payload]) => payload);
  const summary = transactions.map((t) => `${t.contexts.trace.op}:${t.transaction}`).sort();
  check(
    summary.join() === "processing:Processing for SmokeTTS,ttfb:TTFB for SmokeTTS",
    `transactions: ${summary}`,
  );
}
