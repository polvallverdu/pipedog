// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/tracing/setup.py

/**
 * Core OpenTelemetry tracing utilities and setup for Pipecat.
 *
 * This module provides functions to check availability and configure
 * OpenTelemetry tracing for Pipecat applications. It handles the optional
 * nature of OpenTelemetry dependencies and provides a safe setup process.
 *
 * Porting notes: upstream detects OpenTelemetry by trying to import it, and
 * treats it as an optional extra (`pipecat-ai[tracing]`). Here
 * `@opentelemetry/api` is an optional peer dependency of `@pipedog/core`:
 *
 * - When this module loads it starts a dynamic `import("@opentelemetry/api")`
 *   (no top-level await, so importing core never waits or throws). If the
 *   package is not installed the import fails quietly and tracing stays
 *   unavailable, exactly like upstream's `OPENTELEMETRY_AVAILABLE = False`.
 *   Because the import is asynchronous, `isTracingAvailable()` turns true a
 *   moment after core loads; `await loadOpenTelemetry()` waits for it.
 * - `registerOpenTelemetry()` hands the modules in explicitly and
 *   synchronously (it wins over the automatic import). `@pipedog/tracing`'s
 *   `setupTracing()` does this, also registering `@opentelemetry/sdk-trace-base`
 *   and `@opentelemetry/resources`, which this module's `setupTracing()` needs.
 *
 * Without OpenTelemetry every tracing helper is a no-op, as upstream behaves.
 *
 * @example
 * import * as api from "@opentelemetry/api";
 * import * as sdk from "@opentelemetry/sdk-trace-base";
 * import * as resources from "@opentelemetry/resources";
 *
 * registerOpenTelemetry({ api, sdk, resources });
 * setupTracing({ serviceName: "my-service", exporter: new sdk.ConsoleSpanExporter() });
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { logger } from "../logger.ts";

//
// The slice of the OpenTelemetry JS API Pipecat uses, typed structurally so
// core does not depend on the packages.
//

export type OtelAttributeValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | null | undefined>
  | ReadonlyArray<number | null | undefined>
  | ReadonlyArray<boolean | null | undefined>;

/** `SpanContext` from `@opentelemetry/api`. */
export interface OtelSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
}

/** `Span` from `@opentelemetry/api`. */
export interface OtelSpan {
  spanContext(): OtelSpanContext;
  setAttribute(key: string, value: OtelAttributeValue): unknown;
  end(endTime?: unknown): void;
}

/** `Context` from `@opentelemetry/api` (opaque). */
export interface OtelContext {
  getValue(key: symbol): unknown;
}

/** `Tracer` from `@opentelemetry/api`. */
export interface OtelTracer {
  startSpan(name: string, options?: Record<string, unknown>, context?: OtelContext): OtelSpan;
}

/** The `@opentelemetry/api` module. */
export interface OtelApi {
  trace: {
    getTracer(name: string, version?: string): OtelTracer;
    wrapSpanContext(spanContext: OtelSpanContext): OtelSpan;
    setSpan(context: OtelContext, span: OtelSpan): OtelContext;
    setGlobalTracerProvider(provider: unknown): unknown;
  };
  context: {
    active(): OtelContext;
  };
}

/** The `@opentelemetry/sdk-trace-base` module (v2). */
export interface OtelSdkTraceBase {
  // `any`: construct signatures are checked contravariantly, and the SDK's
  // parameter types (TracerConfig, SpanExporter) are not known here.
  BasicTracerProvider: new (config?: {
    resource?: any;
    spanProcessors?: any[];
  }) => unknown;
  BatchSpanProcessor: new (exporter: any) => unknown;
  ConsoleSpanExporter: new () => unknown;
}

/** The `@opentelemetry/resources` module (v2). */
export interface OtelResources {
  resourceFromAttributes(attributes: Record<string, string>): unknown;
}

/** The OpenTelemetry modules handed to `registerOpenTelemetry()`. */
export interface OpenTelemetryModules {
  /** `@opentelemetry/api`. Enables tracing. */
  api: OtelApi;
  /** `@opentelemetry/sdk-trace-base`. Needed by `setupTracing()`. */
  sdk?: OtelSdkTraceBase | null;
  /** `@opentelemetry/resources`. Needed by `setupTracing()`. */
  resources?: OtelResources | null;
}

let openTelemetry: OpenTelemetryModules | null = null;
/** Set once `registerOpenTelemetry()` is called; the automatic import then leaves things alone. */
let registeredExplicitly = false;

/**
 * Import `@opentelemetry/api` if it is installed (upstream's optional import).
 *
 * The specifier is a string literal so bundlers (esbuild/wrangler, Bun.build)
 * bundle the package when it is installed; when it is not, they leave the
 * `import()` in place and it rejects at runtime, which is caught here.
 */
async function importOpenTelemetryApi(): Promise<OtelApi | null> {
  try {
    const mod = (await import("@opentelemetry/api")) as unknown as OtelApi & {
      default?: OtelApi;
    };
    // CommonJS interop (some bundlers) puts the exports on `default`.
    const api = mod?.trace ? mod : mod?.default;
    return api?.trace && api.context ? api : null;
  } catch (e) {
    rethrowIfCancelled(e);
    return null;
  }
}

const autoLoad: Promise<void> = importOpenTelemetryApi().then((api) => {
  if (api && !registeredExplicitly) {
    openTelemetry = { api };
  }
});

/**
 * Wait for the automatic `import("@opentelemetry/api")` started when core
 * loaded, and report whether tracing is available.
 *
 * Only needed when tracing must be on before the first await of the app, e.g.
 * a `PipelineWorker({ enableTracing: true })` built at module top level.
 *
 * @returns True if tracing is available, False otherwise.
 */
export async function loadOpenTelemetry(): Promise<boolean> {
  await autoLoad;
  return isTracingAvailable();
}

/**
 * Make OpenTelemetry available to Pipecat explicitly, instead of (or before)
 * the automatic import of `@opentelemetry/api`. Pass `null` to disable
 * tracing again.
 */
export function registerOpenTelemetry(modules: OpenTelemetryModules | null): void {
  registeredExplicitly = true;
  openTelemetry = modules;
}

/** The registered OpenTelemetry modules, or null if tracing is unavailable. */
export function getOpenTelemetry(): OpenTelemetryModules | null {
  return openTelemetry;
}

/**
 * Check if OpenTelemetry tracing is available and configured.
 *
 * @returns True if tracing is available, False otherwise.
 */
export function isTracingAvailable(): boolean {
  return openTelemetry !== null;
}

function getenv(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    name
  ];
}

export interface SetupTracingOptions {
  /** The name of the service for traces. Defaults to `"pipecat"`. */
  serviceName?: string;
  /**
   * A pre-configured OpenTelemetry span exporter instance. If null, only
   * console export will be available if enabled.
   */
  exporter?: unknown;
  /** Whether to also export traces to console (useful for debugging). */
  consoleExport?: boolean;
}

/**
 * Set up OpenTelemetry tracing with a user-provided exporter.
 *
 * Requires `registerOpenTelemetry()` to have been called with the `sdk` and
 * `resources` modules.
 *
 * @returns True if setup was successful, False otherwise.
 *
 * @example
 * // With OTLP exporter
 * const exporter = new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" });
 * setupTracing({ serviceName: "my-service", exporter });
 */
export function setupTracing(options: SetupTracingOptions = {}): boolean {
  const serviceName = options.serviceName ?? "pipecat";
  const exporter = options.exporter ?? null;
  const consoleExport = options.consoleExport ?? false;

  const otel = openTelemetry;
  if (!otel) {
    return false;
  }

  try {
    const { sdk, resources } = otel;
    if (!sdk || !resources) {
      throw new Error("the OpenTelemetry `sdk` and `resources` modules were not registered");
    }

    // Create a resource with service info
    const resource = resources.resourceFromAttributes({
      "service.name": serviceName,
      "service.instance.id": getenv("HOSTNAME") ?? "unknown",
      "deployment.environment": getenv("ENVIRONMENT") ?? "development",
    });

    const spanProcessors: unknown[] = [];

    // Add console exporter if requested (good for debugging)
    if (consoleExport) {
      const consoleExporter = new sdk.ConsoleSpanExporter();
      spanProcessors.push(new sdk.BatchSpanProcessor(consoleExporter));
    }

    // Add user-provided exporter if available
    if (exporter) {
      spanProcessors.push(new sdk.BatchSpanProcessor(exporter));
    }

    // Set up the tracer provider with the resource
    const tracerProvider = new sdk.BasicTracerProvider({ resource, spanProcessors });
    otel.api.trace.setGlobalTracerProvider(tracerProvider);

    return true;
  } catch (e) {
    rethrowIfCancelled(e);
    logger.error(`Error setting up tracing: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
