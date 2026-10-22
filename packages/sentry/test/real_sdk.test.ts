// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// SentryMetrics against the real @sentry/core tracing functions (which every
// Sentry JS SDK re-exports), with a client whose transport records envelopes
// instead of sending them.

import { describe, expect, test } from "bun:test";

import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import * as Sentry from "@sentry/core";

import { type SentryClient, SentryMetrics } from "../src/sentry.ts";

// The SDK namespace is what users pass; this fails to compile if it stops fitting.
const _namespaceFits: SentryClient = Sentry;

type Envelope = [unknown, [{ type: string }, any][]];

function initSentry(): Envelope[] {
  const envelopes: Envelope[] = [];
  Sentry.initAndBind(
    Sentry.Client as never,
    {
      dsn: "https://public@example.invalid/1",
      tracesSampleRate: 1.0,
      // v11 streams spans by default; transactions (what upstream sends) are the static lifecycle,
      // where `forceTransaction` applies.
      traceLifecycle: "static",
      integrations: [],
      stackParser: () => [],
      transport: () => ({
        send: async (envelope: Envelope) => {
          envelopes.push(envelope);
          return {};
        },
        flush: async () => true,
      }),
    } as never,
  );
  expect(Sentry.isInitialized()).toBe(true);
  return envelopes;
}

async function reportOneOfEach(): Promise<void> {
  const metrics = new SentryMetrics({ sentry: Sentry });
  metrics.setProcessorName("RealTTS");
  await metrics.setup(new TaskManager());

  await metrics.startTtfbMetrics({ reportOnlyInitialTtfb: false });
  await metrics.stopTtfbMetrics();
  await metrics.startProcessingMetrics();
  await metrics.stopProcessingMetrics();
  await metrics.cleanup();
}

describe("SentryMetrics with @sentry/core", () => {
  test("static lifecycle: transactions reach the client's transport", async () => {
    // The lifecycle where `forceTransaction` applies, and what upstream's
    // start_transaction produces.
    const envelopes = initSentry();
    await reportOneOfEach();

    const transactions = envelopes
      .flatMap((envelope) => envelope[1].map(([header, payload]) => ({ header, payload })))
      .filter((item) => item.header.type === "transaction")
      .map((item) => item.payload);
    expect(transactions.map((t) => t.transaction).sort()).toEqual([
      "Processing for RealTTS",
      "TTFB for RealTTS",
    ]);
    expect(transactions.map((t) => t.contexts.trace.op).sort()).toEqual(["processing", "ttfb"]);
  });
});
