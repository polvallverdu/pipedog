// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/services/deepgram/_errors.py

/**
 * Internal descriptions of the errors Deepgram reports when refusing a connection.
 *
 * Porting notes:
 * - DIVERGENCE: upstream matches the `websockets` library's `InvalidStatus`
 *   exception. A standard `WebSocket` exposes neither the handshake's HTTP
 *   status nor its response headers, so `describeRefusal()` duck-types the
 *   error instead: it finds Deepgram's `dg-error` reason only when the error
 *   thrown by the connect (e.g. from a custom `webSocketFactory`) carries a
 *   `response` with `headers` (a `Headers`-like object with `get()`, or a
 *   plain record). The status is read from `status_code`, `statusCode` or
 *   `status`.
 */

/**
 * Describe Deepgram refusing a websocket handshake, if that is what failed.
 *
 * Deepgram explains a refusal (an invalid setting, a bad API key, a model the
 * project can't use) in the `dg-error` response header, which the
 * exception's own message leaves out.
 *
 * @param exception The exception raised by the connection attempt.
 * @returns A description naming the HTTP status and Deepgram's reason, or
 *   null when the exception isn't a refusal carrying one.
 */
export function describeRefusal(exception: unknown): string | null {
  const response = (exception as { response?: any } | null)?.response;
  const headers = response?.headers;
  if (!headers) {
    return null;
  }
  const reason: unknown =
    typeof headers.get === "function" ? headers.get("dg-error") : headers["dg-error"];
  if (reason) {
    const status = response.status_code ?? response.statusCode ?? response.status;
    return `Deepgram refused the connection (HTTP ${status}): ${reason}`;
  }
  return null;
}
