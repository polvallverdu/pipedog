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
 * Porting notes: upstream detects OpenTelemetry by trying to import it. Core
 * takes no third-party dependencies, so the OpenTelemetry JS modules are
 * handed in instead, once, at startup:
 *
 * @example
 * import * as api from "@opentelemetry/api";
 * import * as sdk from "@opentelemetry/sdk-trace-base";
 * import * as resources from "@opentelemetry/resources";
 * import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
 *
 * registerOpenTelemetry({ api, sdk, resources });
 * setupTracing({
 *   serviceName: "my-service",
 *   exporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
 * });
 *
 * Until `registerOpenTelemetry()` is called, `isTracingAvailable()` is false and
 * every tracing helper is a no-op, as upstream behaves without OpenTelemetry.
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
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

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
  BasicTracerProvider: new (config?: { resource?: unknown; spanProcessors?: unknown[] }) => unknown;
  BatchSpanProcessor: new (exporter: unknown) => unknown;
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

/**
 * Make OpenTelemetry available to Pipecat (upstream's optional import).
 * Pass `null` to disable tracing again.
 */
export function registerOpenTelemetry(modules: OpenTelemetryModules | null): void {
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
