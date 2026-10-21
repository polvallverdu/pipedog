// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * AWS Signature Version 4, on WebCrypto (`crypto.subtle`), so it runs on Bun,
 * Node, Deno and Cloudflare Workers. It signs `fetch` requests (header
 * signing) and presigns URLs (query signing, e.g. Transcribe's WebSocket URL).
 */

const encoder = new TextEncoder();

/** Static AWS keys used to sign one request. */
export interface AWSCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function asBytes(data: string | Uint8Array): Uint8Array<ArrayBuffer> {
  if (typeof data === "string") return encoder.encode(data);
  return new Uint8Array(data);
}

/** Hex SHA-256 of a string or bytes. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", asBytes(data)));
}

/** HMAC-SHA256. */
export async function hmacSha256(
  key: string | Uint8Array,
  data: string | Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, asBytes(data)));
}

/** The SigV4 signing key for a date stamp (`YYYYMMDD`), region and service. */
export async function getSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

/** HMAC-SHA256 signature, hex encoded. */
export async function signHex(key: Uint8Array, stringToSign: string): Promise<string> {
  return toHex(await hmacSha256(key, stringToSign));
}

/** RFC 3986 percent-encoding, as SigV4 requires (`A-Z a-z 0-9 - _ . ~` stay). */
export function uriEscape(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Escape each segment of a path, keeping the `/` separators. */
export function uriEscapePath(path: string): string {
  return path
    .split("/")
    .map((segment) => uriEscape(segment))
    .join("/");
}

/** `YYYYMMDDTHHMMSSZ` for a date. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function canonicalQuery(params: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of params) pairs.push([uriEscape(k), uriEscape(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** A request to sign. `url` carries the path exactly as sent on the wire. */
export interface SignRequestOptions {
  method: string;
  url: string | URL;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  service: string;
  region: string;
  credentials: AWSCredentialIdentity;
  /** Signing time (defaults to now). */
  date?: Date;
  /**
   * Payload hash to sign instead of hashing `body`, e.g.
   * `"UNSIGNED-PAYLOAD"` for a streamed body.
   */
  payloadHash?: string;
  /**
   * Whether the canonical URI escapes the (already escaped) wire path once
   * more. True for every service except S3.
   */
  doubleEscapePath?: boolean;
}

/**
 * Sign a request with SigV4 headers. Returns the headers to send: the given
 * ones plus `host`, `x-amz-date`, `x-amz-security-token` (with a session
 * token), `x-amz-content-sha256` when `payloadHash` is set, and
 * `authorization`.
 */
export async function signRequest(options: SignRequestOptions): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const date = options.date ?? new Date();
  const stamp = amzDate(date);
  const dateStamp = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host = url.host;
  headers["x-amz-date"] = stamp;
  if (options.credentials.sessionToken) {
    headers["x-amz-security-token"] = options.credentials.sessionToken;
  }
  const payloadHash = options.payloadHash ?? (await sha256Hex(options.body ?? ""));
  if (options.payloadHash) headers["x-amz-content-sha256"] = payloadHash;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames
    .map((n) => `${n}:${(headers[n] as string).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedNames.join(";");
  const path = url.pathname || "/";
  const canonicalUri = (options.doubleEscapePath ?? true) ? uriEscapePath(path) : path;
  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalUri,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );
  const key = await getSigningKey(
    options.credentials.secretAccessKey,
    dateStamp,
    options.region,
    options.service,
  );
  const signature = await signHex(key, stringToSign);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/** Escape an already-escaped path the way `URL` normalizes it on the wire. */
export function encodePathSegments(...segments: string[]): string {
  return `/${segments.map((s) => uriEscape(s)).join("/")}`;
}
