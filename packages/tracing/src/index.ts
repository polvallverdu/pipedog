// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * OpenTelemetry tracing setup for pipedog.
 *
 * `@pipedog/core` holds the port of Pipecat's tracing (`utils/tracing/*`: the
 * conversation/turn spans, the `stt`/`llm`/`tts` service spans and their
 * attributes) and only needs `@opentelemetry/api`, an optional peer. This
 * package adds what upstream's `pipecat-ai[tracing]` extra brings in: the
 * OpenTelemetry SDK, and `setupTracing()`, which matches upstream's
 * `setup_tracing(service_name, exporter, console_export)`.
 *
 * It also registers the OpenTelemetry modules with core synchronously, so
 * tracing is available as soon as `setupTracing()` returns.
 *
 * @example
 * import { OTLPTraceExporter, setupTracing } from "@pipedog/tracing";
 *
 * setupTracing({
 *   serviceName: "my-voice-bot",
 *   exporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
 * });
 * // ... then new PipelineWorker(pipeline, { enableTracing: true })
 */

import * as api from "@opentelemetry/api";
import * as resources from "@opentelemetry/resources";
import * as sdk from "@opentelemetry/sdk-trace-base";
import {
  setupTracing as coreSetupTracing,
  registerOpenTelemetry,
} from "@pipedog/core/utils/tracing/setup";

export { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
export {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

export interface SetupTracingOptions {
  /** The name of the service for traces. Defaults to `"pipecat"`, as upstream. */
  serviceName?: string;
  /**
   * A pre-configured OpenTelemetry span exporter instance, e.g.
   * `new OTLPTraceExporter({ url })`. If null, only console export is
   * available if enabled.
   */
  exporter?: sdk.SpanExporter | null;
  /** Whether to also export traces to the console (useful for debugging). */
  consoleExport?: boolean;
}

/** Hand the OpenTelemetry modules this package depends on to `@pipedog/core`. */
export function registerWithCore(): void {
  registerOpenTelemetry({ api, sdk, resources });
}

/**
 * Set up OpenTelemetry tracing with a user-provided exporter.
 *
 * Creates a tracer provider with a resource carrying `service.name`,
 * `service.instance.id` (`$HOSTNAME`, else `"unknown"`) and
 * `deployment.environment` (`$ENVIRONMENT`, else `"development"`), adds a
 * `BatchSpanProcessor` for the console exporter (if `consoleExport`) and for
 * `exporter` (if given), and registers it as the global tracer provider.
 * Like upstream, the global provider can only be set once per process.
 *
 * @returns True if setup was successful, False otherwise.
 */
export function setupTracing(options: SetupTracingOptions = {}): boolean {
  registerWithCore();
  return coreSetupTracing(
    options.exporter ? { ...options, exporter: trackExports(options.exporter) } : options,
  );
}

/** Exports that have started and not yet called back, across the exporters of `setupTracing()`. */
const pendingExports = new Set<Promise<void>>();

/**
 * Wraps `exporter` to keep track of the exports in flight.
 *
 * The SDK's `BatchSpanProcessor.forceFlush()` only exports the spans still in its
 * queue. When its timer has just started an export, the spans are no longer in
 * the queue, so it returns at once, before they reach the collector.
 * `forceFlushTracing()` waits for those exports too.
 */
function trackExports(exporter: sdk.SpanExporter): sdk.SpanExporter {
  return {
    export(spans, resultCallback) {
      let done!: () => void;
      const pending = new Promise<void>((resolve) => {
        done = resolve;
      });
      pendingExports.add(pending);
      const finish = () => {
        pendingExports.delete(pending);
        done();
      };
      try {
        exporter.export(spans, (result) => {
          finish();
          resultCallback(result);
        });
      } catch (e) {
        finish();
        throw e;
      }
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: exporter.forceFlush ? () => exporter.forceFlush!() : undefined,
  };
}

interface FlushableProvider {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** The SDK tracer provider behind the global one, if `setupTracing()` (or another SDK) set it. */
function sdkTracerProvider(): FlushableProvider | null {
  let provider: unknown = api.trace.getTracerProvider();
  const proxy = provider as { getDelegate?: () => unknown };
  if (typeof proxy.getDelegate === "function") provider = proxy.getDelegate();
  const p = provider as Partial<FlushableProvider>;
  return typeof p.forceFlush === "function" && typeof p.shutdown === "function"
    ? (p as FlushableProvider)
    : null;
}

/**
 * Export every span the batch processors still hold, and wait for the exports in flight.
 *
 * Not in upstream (a Python process flushes on exit). On Cloudflare Workers
 * call it before the request ends, e.g. `ctx.waitUntil(forceFlushTracing())`,
 * since buffered spans are not exported once the request is over.
 */
export async function forceFlushTracing(): Promise<void> {
  await sdkTracerProvider()?.forceFlush();
  // DIVERGENCE: not in upstream. An export the batch timer started before this call
  // isn't part of `forceFlush()`'s promise (see `trackExports`).
  while (pendingExports.size > 0) await Promise.all([...pendingExports]);
}

/** Flush and shut down the global tracer provider (no more spans are exported). */
export async function shutdownTracing(): Promise<void> {
  await sdkTracerProvider()?.shutdown();
}
