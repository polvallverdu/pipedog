// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/http.py

/**
 * Compatibility helpers for the HTTP client families service SDKs use.
 *
 * Upstream bridges the httpx and httpx2 Python packages: service SDKs are
 * migrating from one to the other, so the objects Pipecat hands to an SDK
 * client — and the exceptions it catches from one — can't name a single
 * family at import time.
 *
 * In JavaScript every SDK talks through `fetch`, so there is one family. The
 * same names are kept so ported services read like upstream:
 *
 * - `AsyncHTTPClient` is whatever client object a caller hands to an SDK.
 * - `TIMEOUT_EXCEPTIONS` are the timeout error types to catch around SDK calls.
 * - `connectionLimits()` builds a plain limits object.
 */

import { TimeoutError } from "@pipedog/asyncio";

/**
 * Type of a caller-supplied async HTTP client. The class belongs to whichever
 * SDK the caller uses, so there is no single type to name here.
 */
export type AsyncHTTPClient = unknown;

type ErrorClass = abstract new (...args: any[]) => Error;

/**
 * Timeout exception types to catch around SDK calls. SDKs wrap request-level
 * timeouts in their own error type, but a timeout while iterating a response
 * stream surfaces as the underlying transport exception.
 *
 * DIVERGENCE: upstream lists httpx/httpx2 `TimeoutException`. Here it is the
 * asyncio `TimeoutError`; a `fetch` aborted by `AbortSignal.timeout()` rejects
 * with a `DOMException` named "TimeoutError", which `isTimeoutException`
 * also recognizes.
 */
export const TIMEOUT_EXCEPTIONS: readonly ErrorClass[] = [TimeoutError];

/** Whether `e` is one of `TIMEOUT_EXCEPTIONS` (or a fetch timeout `DOMException`). */
export function isTimeoutException(e: unknown): boolean {
  if (TIMEOUT_EXCEPTIONS.some((cls) => e instanceof cls)) return true;
  return e instanceof Error && e.name === "TimeoutError";
}

/** Limits fields accepted by `connectionLimits`. */
export interface ConnectionLimits {
  maxConnections?: number | null;
  maxKeepaliveConnections?: number | null;
  keepaliveExpiry?: number | null;
}

/**
 * Build a connection-limits object accepted by the HTTP client.
 *
 * DIVERGENCE: upstream returns an httpx `Limits` instance. `fetch` has no
 * such object, so this returns the plain options for an SDK or agent that
 * reads them field by field.
 *
 * @param options Limits fields (`maxConnections`, `maxKeepaliveConnections`,
 *   `keepaliveExpiry`).
 * @returns A limits object.
 */
export function connectionLimits(options: ConnectionLimits = {}): ConnectionLimits {
  return { ...options };
}
