// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Upstream has no test for pipecat.processors.metrics.sentry, so these tests
// are written for the port, against a fake Sentry client.

import { describe, expect, test } from "bun:test";

import { TaskManager } from "@pipedog/core/utils/asyncio/task_manager";

import {
  type SentryClient,
  SentryMetrics,
  type SentrySpan,
  type SentryStartSpanOptions,
} from "../src/sentry.ts";

class FakeSpan implements SentrySpan {
  ended = 0;
  options: SentryStartSpanOptions;
  spanId: string;
  constructor(options: SentryStartSpanOptions, spanId: string) {
    this.options = options;
    this.spanId = spanId;
  }
  end(): void {
    this.ended += 1;
  }
  spanContext() {
    return { spanId: this.spanId };
  }
}

class FakeSentry implements SentryClient {
  spans: FakeSpan[] = [];
  flushed: (number | undefined)[] = [];
  initialized: boolean;
  constructor(initialized = true) {
    this.initialized = initialized;
  }
  isInitialized(): boolean {
    return this.initialized;
  }
  startInactiveSpan(options: SentryStartSpanOptions): FakeSpan {
    const span = new FakeSpan(options, `span${this.spans.length + 1}`);
    this.spans.push(span);
    return span;
  }
  async flush(timeout?: number): Promise<boolean> {
    this.flushed.push(timeout);
    return true;
  }
}

async function makeMetrics(sentry: FakeSentry): Promise<SentryMetrics> {
  const metrics = new SentryMetrics({ sentry });
  metrics.setProcessorName("TestTTS");
  await metrics.setup(new TaskManager());
  return metrics;
}

describe("SentryMetrics", () => {
  test("ttfb starts a transaction and ends it on stop, returning the metrics frame", async () => {
    const sentry = new FakeSentry();
    const metrics = await makeMetrics(sentry);

    await metrics.startTtfbMetrics({ reportOnlyInitialTtfb: false });
    expect(sentry.spans.length).toEqual(1);
    expect(sentry.spans[0]?.options).toEqual({
      op: "ttfb",
      name: "TTFB for TestTTS",
      forceTransaction: true,
    });
    expect(sentry.spans[0]?.ended).toEqual(0);

    const frame = await metrics.stopTtfbMetrics();
    expect(frame?.data[0]?.processor).toEqual("TestTTS");

    await metrics.cleanup();
    expect(sentry.spans[0]?.ended).toEqual(1);
    expect(sentry.flushed).toEqual([5000]);
  });

  test("processing metrics start and end a processing transaction", async () => {
    const sentry = new FakeSentry();
    const metrics = await makeMetrics(sentry);

    await metrics.startProcessingMetrics();
    expect(sentry.spans[0]?.options).toEqual({
      op: "processing",
      name: "Processing for TestTTS",
      forceTransaction: true,
    });

    const frame = await metrics.stopProcessingMetrics();
    expect(frame).not.toBeNull();

    await metrics.cleanup();
    expect(sentry.spans[0]?.ended).toEqual(1);
  });

  test("reportOnlyInitialTtfb starts no transaction, as upstream", async () => {
    // Upstream checks `_should_report_ttfb` after the base class has already
    // turned it off for reportOnlyInitialTtfb, so that mode never starts a
    // Sentry transaction. Kept as is for parity.
    const sentry = new FakeSentry();
    const metrics = await makeMetrics(sentry);

    await metrics.startTtfbMetrics({ reportOnlyInitialTtfb: true });
    await metrics.stopTtfbMetrics();
    await metrics.startTtfbMetrics({ reportOnlyInitialTtfb: true });
    await metrics.stopTtfbMetrics();

    await metrics.cleanup();
    expect(sentry.spans).toEqual([]);
  });

  test("a stop without a start sends nothing", async () => {
    const sentry = new FakeSentry();
    const metrics = await makeMetrics(sentry);

    expect(await metrics.stopTtfbMetrics()).toBeNull();
    expect(await metrics.stopProcessingMetrics()).toBeNull();

    await metrics.cleanup();
    expect(sentry.spans).toEqual([]);
  });

  test("every pending transaction is ended before cleanup flushes", async () => {
    const sentry = new FakeSentry();
    const metrics = await makeMetrics(sentry);

    for (let i = 0; i < 3; i++) {
      await metrics.startProcessingMetrics();
      await metrics.stopProcessingMetrics();
    }
    await metrics.cleanup();
    expect(sentry.spans.map((s) => s.ended)).toEqual([1, 1, 1]);
    expect(sentry.flushed.length).toEqual(1);
  });

  test("an uninitialized SDK disables Sentry but keeps the metrics", async () => {
    const sentry = new FakeSentry(false);
    const metrics = await makeMetrics(sentry);

    await metrics.startTtfbMetrics({ reportOnlyInitialTtfb: false });
    const ttfb = await metrics.stopTtfbMetrics();
    await metrics.startProcessingMetrics();
    const processing = await metrics.stopProcessingMetrics();
    await metrics.cleanup();

    expect(ttfb).not.toBeNull();
    expect(processing).not.toBeNull();
    expect(sentry.spans).toEqual([]);
    expect(sentry.flushed).toEqual([]);
  });

  test("a span that throws on end does not stop the queue", async () => {
    const sentry = new FakeSentry();
    const metrics = await makeMetrics(sentry);

    await metrics.startProcessingMetrics();
    (sentry.spans[0] as FakeSpan).end = () => {
      throw new Error("boom");
    };
    await metrics.stopProcessingMetrics();
    await metrics.startProcessingMetrics();
    await metrics.stopProcessingMetrics();

    await metrics.cleanup();
    expect(sentry.spans[1]?.ended).toEqual(1);
  });
});
