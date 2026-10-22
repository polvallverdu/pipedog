// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/processors/metrics/sentry.py

/**
 * Sentry integration for frame processor metrics.
 *
 * DIVERGENCE: upstream calls the `sentry_sdk` module directly. Sentry's JS SDKs
 * are per runtime (`@sentry/node`, `@sentry/bun`, `@sentry/deno`,
 * `@sentry/cloudflare`, ...) and all re-export the same tracing functions from
 * `@sentry/core`, so `SentryMetrics` takes the SDK namespace as `sentry` and
 * uses only the three functions of `SentryClient`. It depends on no Sentry
 * package itself and runs wherever the SDK you pass in does.
 *
 * `sentry_sdk.start_transaction()` has no counterpart in the v8+ JS SDKs; a
 * transaction there is a root span, started with `startInactiveSpan()`. Under
 * `@sentry/cloudflare` the Worker has to be wrapped with `withSentry()` (or the
 * Vite plugin) so the SDK is initialised per request; `isInitialized()` is
 * what tells `SentryMetrics` whether it is.
 */

import { Queue, rethrowIfCancelled, type Task } from "@pipedog/asyncio";
import type { MetricsFrame } from "@pipedog/core/frames/frames";
import { FrameProcessorMetrics } from "@pipedog/core/processors/metrics/frame_processor_metrics";
import type { BaseTaskManager } from "@pipedog/core/utils/asyncio/task_manager";
import { logger } from "@pipedog/core/utils/logger";

/** The part of a Sentry span `SentryMetrics` uses. */
export interface SentrySpan {
  /** Finish the span. */
  end(endTimestamp?: number): void;
  /** The span's identifiers, used in log lines when present. */
  spanContext?(): { spanId: string };
}

/** The options `SentryMetrics` passes to `startInactiveSpan()`. */
export interface SentryStartSpanOptions {
  /** The operation: `"ttfb"` or `"processing"`. */
  op: string;
  /** The span's name. */
  name: string;
  /** Show the span as a transaction (a root span with its own trace entry). */
  forceTransaction: boolean;
}

/**
 * The minimal Sentry SDK surface `SentryMetrics` needs. The namespace of any
 * Sentry JS SDK satisfies it (`import * as Sentry from "@sentry/cloudflare"`).
 */
export interface SentryClient {
  /** Whether `Sentry.init()` has run (upstream: `sentry_sdk.is_initialized()`). */
  isInitialized(): boolean;
  /** Start a span without making it active (upstream: `sentry_sdk.start_transaction()`). */
  startInactiveSpan(options: SentryStartSpanOptions): SentrySpan;
  /** Send pending events. Resolves to false if the timeout (milliseconds) is hit. */
  flush(timeout?: number): PromiseLike<boolean>;
}

export interface SentryMetricsOptions {
  /** The Sentry SDK to report to, for example `import * as Sentry from "@sentry/node"`. */
  sentry: SentryClient;
}

/** Seconds to wait for Sentry to send pending events at cleanup, as upstream. */
const FLUSH_TIMEOUT_SECS = 5.0;

/**
 * Frame processor metrics integration with Sentry monitoring.
 *
 * Extends `FrameProcessorMetrics` to send time-to-first-byte (TTFB) and
 * processing metrics as Sentry transactions for performance monitoring
 * and debugging.
 *
 * @example
 * import * as Sentry from "@sentry/node";
 *
 * Sentry.init({ dsn: "...", tracesSampleRate: 1.0 });
 * const llm = new OpenAILLMService({ metrics: new SentryMetrics({ sentry: Sentry }) });
 */
export class SentryMetrics extends FrameProcessorMetrics {
  #sentry: SentryClient;
  #ttfbMetricsTx: SentrySpan | null = null;
  #processingMetricsTx: SentrySpan | null = null;
  #sentryAvailable: boolean;
  #sentryTask: Task<unknown> | null = null;
  #sentryQueue: Queue<SentrySpan | null> | null = null;

  /**
   * Initialize the Sentry metrics collector.
   *
   * Sets up internal state for tracking transactions and verifies
   * Sentry SDK initialization status.
   *
   * @param options.sentry The Sentry SDK to report to.
   */
  constructor(options: SentryMetricsOptions) {
    super();
    this.#sentry = options.sentry;
    this.#sentryAvailable = this.#sentry.isInitialized();
    if (!this.#sentryAvailable) {
      logger.warning("Sentry SDK not initialized. Sentry features will be disabled.");
    }
  }

  /**
   * Setup the Sentry metrics system.
   *
   * @param taskManager The task manager to use for background operations.
   */
  override async setup(taskManager: BaseTaskManager | unknown): Promise<void> {
    await super.setup(taskManager);
    if (this.#sentryAvailable) {
      this.#sentryQueue = new Queue<SentrySpan | null>();
      this.#sentryTask = this.createTask(() => this.#sentryTaskHandler());
    }
  }

  /**
   * Clean up Sentry resources and flush pending transactions.
   *
   * Ensures all pending transactions are sent to Sentry before shutdown.
   */
  override async cleanup(): Promise<void> {
    await super.cleanup();
    if (this.#sentryTask && this.#sentryQueue) {
      await this.#sentryQueue.put(null);
      await this.#sentryTask;
      this.#sentryTask = null;
      logger.trace(`${this} Flushing Sentry metrics`);
      // Sentry's flush takes milliseconds; ours is seconds, like upstream's.
      await this.#sentry.flush(FLUSH_TIMEOUT_SECS * 1000);
    }
  }

  /**
   * Start tracking time-to-first-byte metrics.
   *
   * @param options.startTime Optional start timestamp override.
   * @param options.reportOnlyInitialTtfb Whether to report only the initial TTFB measurement.
   */
  override async startTtfbMetrics(options: {
    startTime?: number | null;
    reportOnlyInitialTtfb: boolean;
  }): Promise<void> {
    await super.startTtfbMetrics(options);

    if (this._shouldReportTtfb && this.#sentryAvailable) {
      this.#ttfbMetricsTx = this.#sentry.startInactiveSpan({
        op: "ttfb",
        name: `TTFB for ${this._processorName()}`,
        forceTransaction: true,
      });
      logger.debug(
        `${this} Sentry transaction started (ID: ${this.#ttfbMetricsTx.spanContext?.().spanId} ` +
          `Name: TTFB for ${this._processorName()})`,
      );
    }
  }

  /**
   * Stop tracking time-to-first-byte metrics.
   *
   * @param options.endTime Optional end timestamp override.
   * @returns MetricsFrame produced by the base class, or null if not measuring.
   *   Returning the frame is required so `FrameProcessor.stopTtfbMetrics`
   *   can push it downstream to observers.
   */
  override async stopTtfbMetrics(
    options: { endTime?: number | null } = {},
  ): Promise<MetricsFrame | null> {
    const frame = await super.stopTtfbMetrics(options);

    if (this.#sentryAvailable && this.#ttfbMetricsTx) {
      await this.#sentryQueue?.put(this.#ttfbMetricsTx);
      this.#ttfbMetricsTx = null;
    }

    return frame;
  }

  /**
   * Start tracking frame processing metrics.
   *
   * @param options.startTime Optional start timestamp override.
   */
  override async startProcessingMetrics(
    options: { startTime?: number | null } = {},
  ): Promise<void> {
    await super.startProcessingMetrics(options);

    if (this.#sentryAvailable) {
      this.#processingMetricsTx = this.#sentry.startInactiveSpan({
        op: "processing",
        name: `Processing for ${this._processorName()}`,
        forceTransaction: true,
      });
      logger.debug(
        `${this} Sentry transaction started (ID: ${this.#processingMetricsTx.spanContext?.().spanId} ` +
          `Name: Processing for ${this._processorName()})`,
      );
    }
  }

  /**
   * Stop tracking frame processing metrics.
   *
   * @param options.endTime Optional end timestamp override.
   * @returns MetricsFrame produced by the base class, or null if not measuring.
   *   Returning the frame is required so `FrameProcessor.stopProcessingMetrics`
   *   can push it downstream to observers.
   */
  override async stopProcessingMetrics(
    options: { endTime?: number | null } = {},
  ): Promise<MetricsFrame | null> {
    const frame = await super.stopProcessingMetrics(options);

    if (this.#sentryAvailable && this.#processingMetricsTx) {
      await this.#sentryQueue?.put(this.#processingMetricsTx);
      this.#processingMetricsTx = null;
    }

    return frame;
  }

  /** Background task handler for completing Sentry transactions. */
  async #sentryTaskHandler(): Promise<void> {
    const queue = this.#sentryQueue as Queue<SentrySpan | null>;
    let running = true;
    while (running) {
      const tx = await queue.get();
      if (tx) {
        // Upstream runs tx.finish in an executor thread; ending a span in JS
        // only records the end time and queues the event.
        try {
          tx.end();
        } catch (e) {
          rethrowIfCancelled(e);
          logger.warning(`${this} failed to finish a Sentry transaction: ${e}`);
        }
      }
      running = tx !== null;
      queue.taskDone();
    }
  }
}
