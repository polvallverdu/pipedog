// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipecat-ts contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/utils/errors.py

/**
 * Error classification shared by services.
 *
 * Provides a provider-agnostic vocabulary for *why* an operation failed, so that
 * callers can tell a transient failure (worth retrying) from a permanent one
 * (retrying will never help).
 */

import { TimeoutError } from "@pipecat-ts/asyncio";

/**
 * Why an operation failed, independent of the provider that failed it.
 *
 * - UNKNOWN: The cause could not be determined.
 * - AUTHENTICATION: Credentials are missing or invalid.
 * - AUTHORIZATION: Credentials are valid but lack access to the resource.
 * - INVALID_REQUEST: The request itself is malformed or names something that
 *   doesn't exist, such as an unknown model or voice.
 * - RATE_LIMIT: Too many requests were sent in too short a window.
 * - QUOTA: The account's credit or usage allowance is exhausted.
 * - CONNECTIVITY: The service could not be reached.
 * - SERVER: The provider reported an internal failure.
 * - APPLICATION: The application failed, not the provider. Reported by a
 *   service on behalf of code it invoked — a tool handler, say — or for
 *   application-supplied content a provider rejected once the service
 *   has repaired its context (e.g. removed the rejected file message).
 *   Either way the failure says nothing about the service's own health.
 */
export class ErrorCategory {
  static readonly UNKNOWN = new ErrorCategory("UNKNOWN", "unknown");
  static readonly AUTHENTICATION = new ErrorCategory("AUTHENTICATION", "authentication");
  static readonly AUTHORIZATION = new ErrorCategory("AUTHORIZATION", "authorization");
  static readonly INVALID_REQUEST = new ErrorCategory("INVALID_REQUEST", "invalid_request");
  static readonly RATE_LIMIT = new ErrorCategory("RATE_LIMIT", "rate_limit");
  static readonly QUOTA = new ErrorCategory("QUOTA", "quota");
  static readonly CONNECTIVITY = new ErrorCategory("CONNECTIVITY", "connectivity");
  static readonly SERVER = new ErrorCategory("SERVER", "server");
  static readonly APPLICATION = new ErrorCategory("APPLICATION", "application");

  readonly name: string;
  readonly value: string;

  private constructor(name: string, value: string) {
    this.name = name;
    this.value = value;
  }

  /** All categories, in declaration order. */
  static values(): readonly ErrorCategory[] {
    return [
      ErrorCategory.UNKNOWN,
      ErrorCategory.AUTHENTICATION,
      ErrorCategory.AUTHORIZATION,
      ErrorCategory.INVALID_REQUEST,
      ErrorCategory.RATE_LIMIT,
      ErrorCategory.QUOTA,
      ErrorCategory.CONNECTIVITY,
      ErrorCategory.SERVER,
      ErrorCategory.APPLICATION,
    ];
  }

  /** The category with the given value (`ErrorCategory("quota")`). */
  static fromValue(value: string): ErrorCategory {
    const category = ErrorCategory.values().find((c) => c.value === value);
    if (!category) {
      throw new Error(`'${value}' is not a valid ErrorCategory`);
    }
    return category;
  }

  /**
   * Whether the failure will keep recurring until something changes.
   *
   * A permanent failure gives the same result every time it is retried:
   * the credentials stay rejected, the request stays malformed. Only new
   * credentials or settings can clear it, so retrying is pointless.
   */
  get isPermanent(): boolean {
    return PERMANENT_CATEGORIES.has(this);
  }

  toString(): string {
    return `ErrorCategory.${this.name}`;
  }
}

const PERMANENT_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  ErrorCategory.AUTHENTICATION,
  ErrorCategory.AUTHORIZATION,
  ErrorCategory.INVALID_REQUEST,
]);

const HTTP_STATUS_CODE_CATEGORIES: ReadonlyMap<number, ErrorCategory> = new Map([
  [400, ErrorCategory.INVALID_REQUEST],
  [401, ErrorCategory.AUTHENTICATION],
  [402, ErrorCategory.QUOTA],
  [403, ErrorCategory.AUTHORIZATION],
  [404, ErrorCategory.INVALID_REQUEST],
  [422, ErrorCategory.INVALID_REQUEST],
  [429, ErrorCategory.RATE_LIMIT],
]);

// Error codes JS runtimes attach to connection failures (Python's
// ConnectionError subclasses and socket.gaierror).
const CONNECTIVITY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ConnectionRefused",
  "ConnectionClosed",
]);

// Python matches ConnectionError, TimeoutError and socket.gaierror. JS has no
// such hierarchy: match asyncio/DOM timeouts, network errors, the error codes
// above, and fetch's "fetch failed" TypeError (also on its `cause`).
function isConnectivityError(exception: unknown): boolean {
  if (exception instanceof TimeoutError) return true;
  if (typeof exception !== "object" || exception === null) return false;
  const e = exception as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (e.name === "TimeoutError" || e.name === "NetworkError") return true;
  if (typeof e.code === "string" && CONNECTIVITY_ERROR_CODES.has(e.code)) return true;
  if (exception instanceof TypeError && typeof e.message === "string") {
    if (/fetch failed|network|connect/i.test(e.message)) return true;
  }
  if (e.cause !== undefined && e.cause !== exception) return isConnectivityError(e.cause);
  return false;
}

/**
 * Classify an HTTP status code.
 *
 * @param statusCode The HTTP status code reported by the provider.
 * @returns The matching category, or `ErrorCategory.UNKNOWN` if the code carries
 *   no provider-independent meaning.
 */
export function classifyHttpStatusCode(statusCode: number): ErrorCategory {
  const category = HTTP_STATUS_CODE_CATEGORIES.get(statusCode);
  if (category) {
    return category;
  }
  if (statusCode >= 500 && statusCode < 600) {
    return ErrorCategory.SERVER;
  }
  return ErrorCategory.UNKNOWN;
}

function getAttr(obj: unknown, name: string): unknown {
  if ((typeof obj !== "object" && typeof obj !== "function") || obj === null) return undefined;
  return (obj as Record<string, unknown>)[name];
}

/**
 * Extract an HTTP status code from an exception, if it carries one.
 *
 * Recognizes the attribute shapes used by the HTTP and websocket libraries
 * services build on: a `response` holding `status_code` / `statusCode` or
 * `status` (e.g. a fetch `Response`), and those same attributes directly on
 * the exception (provider SDKs).
 *
 * @param exception The exception to inspect.
 * @returns The status code, or null if the exception doesn't carry one.
 */
export function extractHttpStatusCode(exception: unknown): number | null {
  const response = getAttr(exception, "response");
  const candidates = [
    getAttr(response, "status_code"),
    getAttr(response, "statusCode"),
    getAttr(response, "status"),
    getAttr(exception, "status_code"),
    getAttr(exception, "statusCode"),
    getAttr(exception, "status"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Classify an exception by the HTTP status code it carries.
 *
 * @param exception The exception to classify.
 * @returns The matching category, or `ErrorCategory.UNKNOWN` when the exception is
 *   not recognized. Providers that throw SDK-specific exceptions carrying no
 *   status code need their own classification.
 */
export function classifyHttpException(exception: unknown): ErrorCategory {
  const statusCode = extractHttpStatusCode(exception);
  if (statusCode !== null) {
    return classifyHttpStatusCode(statusCode);
  }
  if (isConnectivityError(exception)) {
    return ErrorCategory.CONNECTIVITY;
  }
  return ErrorCategory.UNKNOWN;
}
