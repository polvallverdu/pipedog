// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A small fetch-based HTTP client for the hosted classifier clients, standing
// in for the parts of `httpx.AsyncClient` they use: a base URL, default
// headers, a per-request timeout, JSON bodies, and a swappable transport so
// tests can answer requests without a network (as upstream tests swap in an
// `httpx.MockTransport`).
//
// HTTP/2 and connection keep-alive are left to the runtime's `fetch`.

import { abortable, currentSignal, rethrowIfCancelled } from "@pipedog/asyncio";

/** A request could not be sent or answered (upstream's `httpx.HTTPError`). */
export class HttpError extends Error {
  override name = "HttpError";
}

/** The request was not answered in time (upstream's `httpx.TimeoutException`). */
export class HttpTimeoutError extends HttpError {
  override name = "HttpTimeoutError";
}

/** Python's `repr()` of an exception: `Name('message')`. */
export function errorRepr(e: unknown): string {
  if (e instanceof Error) {
    return `${e.name}('${e.message}')`;
  }
  return String(e);
}

/** A received response, its body already read. */
export class HttpResponse {
  readonly statusCode: number;
  readonly text: string;

  constructor(statusCode: number, text: string) {
    this.statusCode = statusCode;
    this.text = text;
  }

  /** The body parsed as JSON; throws a SyntaxError if it is not JSON. */
  json(): unknown {
    return JSON.parse(this.text);
  }
}

export interface HttpClientOptions {
  /** Prepended to every request path. */
  baseUrl: string;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  /** Seconds to wait for a reply before giving up. */
  timeout?: number;
  /** The transport; the global `fetch` by default. */
  fetch?: typeof fetch;
}

export interface HttpRequestOptions {
  /** Query parameters. */
  params?: Record<string, string>;
  /** A body to send as JSON. */
  json?: unknown;
  /** Headers for this request, on top of the client's. */
  headers?: Record<string, string>;
}

/** Sends requests to one API. */
export class HttpClient {
  /** The transport requests go through; replace it to answer them in tests. */
  transport: typeof fetch;
  protected _baseUrl: string;
  protected _headers: Record<string, string>;
  protected _timeout: number;
  protected _closed = false;

  constructor(options: HttpClientOptions) {
    this._baseUrl = options.baseUrl.replace(/\/+$/, "");
    this._headers = options.headers ?? {};
    this._timeout = options.timeout ?? 5.0;
    this.transport = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Whether the client has been closed. */
  get isClosed(): boolean {
    return this._closed;
  }

  /** Send a GET request. */
  async get(path: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    return await this.request("GET", path, options);
  }

  /** Send a POST request. */
  async post(path: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    return await this.request("POST", path, options);
  }

  /**
   * Send a request and read its whole body.
   *
   * @throws HttpError If the request could not be sent, or was not answered
   *   within the timeout (`HttpTimeoutError`).
   */
  async request(
    method: string,
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse> {
    if (this._closed) {
      throw new Error("Cannot send a request, as the client has been closed.");
    }
    let url = `${this._baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    if (options.params && Object.keys(options.params).length > 0) {
      url += `?${new URLSearchParams(options.params).toString()}`;
    }
    const headers: Record<string, string> = { ...this._headers, ...(options.headers ?? {}) };
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["Content-Type"] = "application/json";
    }
    const timeoutSignal = AbortSignal.timeout(this._timeout * 1000);
    const signal = AbortSignal.any([currentSignal(), timeoutSignal]);
    try {
      return await abortable(
        (async () => {
          const response = await this.transport(url, { method, headers, body, signal });
          const text = await response.text();
          return new HttpResponse(response.status, text);
        })(),
      );
    } catch (e) {
      rethrowIfCancelled(e);
      if (timeoutSignal.aborted) {
        throw new HttpTimeoutError(`timed out after ${this._timeout}s`, { cause: e });
      }
      if (e instanceof HttpError) {
        throw e;
      }
      throw new HttpError(e instanceof Error ? e.message : String(e), { cause: e });
    }
  }

  /** Close the client; later requests throw. */
  async aclose(): Promise<void> {
    this._closed = true;
  }
}

/** Base64 of `data`, without `Buffer`. */
export function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Whether `value` is a JSON object (a Python dict). */
export function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's `float(value)`: a number from a number or numeric string, else a TypeError/ValueError. */
export function toFloat(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (/^[+-]?(inf|infinity)$/.test(trimmed)) {
      return trimmed.startsWith("-") ? -Infinity : Infinity;
    }
    if (trimmed === "nan" || trimmed === "+nan" || trimmed === "-nan") {
      return Number.NaN;
    }
    const n = Number(trimmed);
    if (trimmed !== "" && Number.isFinite(n)) {
      return n;
    }
    throw new RangeError(`could not convert string to float: '${value}'`);
  }
  throw new TypeError(
    `float() argument must be a string or a real number, not '${value === null ? "NoneType" : typeof value}'`,
  );
}

/** Python's `value or ""`: the value, or an empty string when it is falsy (null, "", {} or []). */
export function orEmpty(value: unknown): unknown {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "" : value;
  }
  if (isDict(value) && Object.keys(value).length === 0) {
    return "";
  }
  return value;
}
