// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * Telnyx TeXML helpers for telephony bots: the HTTP side around `TelnyxFrameSerializer`.
 *
 * - `verifyTelnyxSignature()` checks a webhook's Ed25519 signature (WebCrypto).
 * - `answerTexml()` answers a call by connecting it to the bot's media WebSocket.
 * - `parseStatusCallback()` and `parseCallCost()` read TeXML status callbacks and the `call.cost`
 *   webhook.
 * - `TelnyxTexmlClient` places outbound calls and looks them up through the TeXML REST API.
 *
 * Not in upstream (Pipecat leaves this to the app). Runs on Bun, Node, Deno and Workers: only
 * `fetch` and `crypto.subtle`.
 */

import { rethrowIfCancelled } from "@pipedog/asyncio";
import { base64ToBytes } from "@pipedog/core/utils/base64";

const TELNYX_API = "https://api.telnyx.com/v2";
const E164 = /^\+[1-9]\d{7,14}$/;

/** Default tolerance between a webhook's timestamp and now, in seconds. */
export const TELNYX_SIGNATURE_TOLERANCE = 300;

export interface VerifyTelnyxSignatureOptions {
  /** The raw request body, exactly as received. */
  body: string | Uint8Array;
  /** The `telnyx-signature-ed25519` header (base64). */
  signature: string | null | undefined;
  /** The `telnyx-timestamp` header (Unix seconds). */
  timestamp: string | null | undefined;
  /** The account's public key (Mission Control → Keys & Credentials), base64. */
  publicKey: string;
  /** How far the timestamp may be from now, in seconds. Default 300. */
  tolerance?: number;
  /** Current time in milliseconds (for tests). Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Check a Telnyx webhook signature: Ed25519 over `${timestamp}|${body}`, with the timestamp
 * within `tolerance` seconds of now (a replayed request is refused).
 *
 * @returns True if the request is signed by the key's owner.
 */
export async function verifyTelnyxSignature(
  options: VerifyTelnyxSignatureOptions,
): Promise<boolean> {
  const { signature, timestamp } = options;
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  const now = options.now ?? Date.now();
  const tolerance = options.tolerance ?? TELNYX_SIGNATURE_TOLERANCE;
  if (Math.abs(now / 1000 - Number(timestamp)) > tolerance) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      base64ToBytes(options.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const encoder = new TextEncoder();
    const prefix = encoder.encode(`${timestamp}|`);
    const body = typeof options.body === "string" ? encoder.encode(options.body) : options.body;
    const signed = new Uint8Array(prefix.byteLength + body.byteLength);
    signed.set(prefix, 0);
    signed.set(body, prefix.byteLength);
    return await crypto.subtle.verify("Ed25519", key, base64ToBytes(signature), signed);
  } catch (e) {
    rethrowIfCancelled(e);
    // A malformed key or signature is not a valid signature.
    return false;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export interface AnswerTexmlOptions {
  /** `<Parameter>`s Telnyx passes to the WebSocket in the `start` message's `custom_parameters`. */
  parameters?: Record<string, string>;
  /** `bidirectionalCodec` (e.g. `"PCMU"`, `"PCMA"`, `"L16"`). Telnyx's default if omitted. */
  codec?: string;
  /** Which audio Telnyx streams: `"inbound_track"`, `"outbound_track"` or `"both_tracks"`. */
  track?: string;
}

/** TeXML that connects an answered call to a bidirectional media WebSocket. */
export function answerTexml(streamUrl: string, options: AnswerTexmlOptions = {}): string {
  let attributes = `url="${escapeXml(streamUrl)}" bidirectionalMode="rtp"`;
  if (options.codec) attributes += ` bidirectionalCodec="${escapeXml(options.codec)}"`;
  if (options.track) attributes += ` track="${escapeXml(options.track)}"`;
  const parameters = Object.entries(options.parameters ?? {})
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Response><Connect><Stream ${attributes}>${parameters}</Stream></Connect></Response>`
  );
}

/** Call statuses TeXML reports. */
export const TELNYX_CALL_STATUSES = [
  "queued",
  "initiated",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
] as const;
export type TelnyxCallStatus = (typeof TELNYX_CALL_STATUSES)[number];

function isCallStatus(value: unknown): value is TelnyxCallStatus {
  return (TELNYX_CALL_STATUSES as readonly unknown[]).includes(value);
}

const INVALID_HANGUP_CAUSES = new Set([
  "unallocated_number",
  "invalid_number_format",
  "number_changed",
  "not_found",
]);

/**
 * Whether a Telnyx response or callback says the number itself is unusable (unallocated, badly
 * formatted, changed), so calling it again won't help. Busy, no answer, routing and generic
 * failures are not.
 */
export function isInvalidDestination(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  const cause = String(record.HangupCause ?? record.hangup_cause ?? "").toLowerCase();
  if (INVALID_HANGUP_CAUSES.has(cause)) return true;
  if (!Array.isArray(record.errors)) return false;
  return record.errors.some((error: unknown) => {
    if (typeof error !== "object" || error === null) return false;
    const { source, code } = error as { source?: unknown; code?: unknown };
    const pointer =
      typeof source === "object" && source !== null
        ? String((source as { pointer?: unknown }).pointer ?? "").toLowerCase()
        : "";
    // 10016: "Phone number must be in +E.164 format" / not routable, on the destination.
    return (pointer === "/to" || pointer === "/destination") && String(code) === "10016";
  });
}

export interface TelnyxStatusCallback {
  /** The TeXML `CallSid` (the call control id). */
  callSid: string;
  status: TelnyxCallStatus;
  /** Whether the hang-up cause says the number is unusable (see `isInvalidDestination`). */
  invalidDestination: boolean;
  /** Every form field, as sent. */
  fields: Record<string, string>;
}

/** Parse a TeXML status callback (form-encoded), or null if it has no call id or known status. */
export function parseStatusCallback(body: string | URLSearchParams): TelnyxStatusCallback | null {
  const fields = Object.fromEntries(typeof body === "string" ? new URLSearchParams(body) : body);
  const status = fields.CallStatus;
  if (!fields.CallSid || !isCallStatus(status)) return null;
  return {
    callSid: fields.CallSid,
    status,
    invalidDestination: isInvalidDestination(fields),
    fields,
  };
}

/** What Telnyx charged for a call, from its `call.cost` webhook. */
export interface TelnyxCallCost {
  /** The call control id (a TeXML call's `CallSid`). */
  callControlId: string;
  /** Whether Telnyx could work the cost out. */
  status: "success" | "error";
  totalCost: number | null;
  currency: string | null;
  billedSeconds: number | null;
  /** Cost by part of the call (`sip-trunking`, `call-control`, ...). */
  parts: { part: string; cost: number | null; billedSeconds: number | null }[];
}

function amount(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return value !== "" && Number.isFinite(parsed) ? parsed : null;
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse Telnyx's `call.cost` webhook (JSON text or parsed), or null for anything else. */
export function parseCallCost(body: string | unknown): TelnyxCallCost | null {
  let json: unknown = body;
  if (typeof body === "string") {
    try {
      json = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const data = record(record(json)?.data);
  if (data?.event_type !== "call.cost") return null;
  const payload = record(data.payload);
  if (!payload) return null;
  const callControlId = payload.call_control_id;
  const status = payload.status;
  if (typeof callControlId !== "string" || !callControlId) return null;
  if (status !== "success" && status !== "error") return null;
  const parts = (Array.isArray(payload.cost_parts) ? payload.cost_parts : [])
    .map(record)
    .filter((part): part is Record<string, unknown> => part !== null);
  const currency = parts.find((part) => typeof part.currency === "string" && part.currency)
    ?.currency as string | undefined;
  return {
    callControlId,
    status,
    totalCost: amount(payload.total_cost),
    currency: currency ?? null,
    billedSeconds: seconds(payload.billed_duration_secs),
    parts: parts.map((part) => ({
      part: String(part.call_part ?? ""),
      cost: amount(part.cost),
      billedSeconds: seconds(part.billed_duration_secs),
    })),
  };
}

/** Telnyx refused to place the call: retrying the same request won't help. */
export class TelnyxCallRejectedError extends Error {
  /** Telnyx's HTTP status, or null if the request was refused before it was sent. */
  readonly status: number | null;
  /** Whether the destination number itself is unusable (see `isInvalidDestination`). */
  readonly invalidDestination: boolean;
  /** Telnyx's response body, if any. */
  readonly response: unknown;

  constructor(
    message: string,
    options: { status?: number | null; invalidDestination?: boolean; response?: unknown } = {},
  ) {
    super(message);
    this.name = "TelnyxCallRejectedError";
    this.status = options.status ?? null;
    this.invalidDestination = options.invalidDestination ?? false;
    this.response = options.response ?? null;
  }
}

export interface TelnyxTexmlClientOptions {
  /** Telnyx API key (v2). */
  apiKey: string;
  /** TeXML account SID: the `Accounts/{sid}` in the TeXML REST API. */
  accountSid: string;
  /** TeXML application (connection) that places the calls. */
  applicationSid: string;
  /** Default caller id, E.164. */
  from?: string;
  /** `fetch` to use (for tests or a proxy). Defaults to the global one. */
  fetch?: typeof globalThis.fetch;
  /** Request timeout in seconds. Default 20. */
  timeout?: number;
  /** API base URL. Default `https://api.telnyx.com/v2`. */
  baseUrl?: string;
}

export interface TelnyxDialOptions {
  /** Destination, E.164. */
  to: string;
  /** Caller id, E.164. Defaults to the client's `from`. */
  from?: string;
  /** Telnyx fetches the call's TeXML from here when it is answered (e.g. `answerTexml()`). */
  url: string;
  /** HTTP method Telnyx uses for `url`. Telnyx's default (POST) if omitted. */
  method?: "GET" | "POST";
  /** Receives the call's status callbacks (see `parseStatusCallback`). */
  statusCallback?: string;
  /** Which statuses to report. Default `initiated ringing answered completed`. */
  statusCallbackEvents?: string[];
  /** More TeXML call parameters (`Timeout`, `MachineDetection`, ...), sent as given. */
  extra?: Record<string, unknown>;
  /** Cancels the request. */
  signal?: AbortSignal;
}

export interface TelnyxCall {
  /** The call control id (the TeXML `CallSid`). */
  callSid: string;
  /** TeXML status, if the response has one. */
  status: string | null;
  /** Whether the response says the number is unusable (see `isInvalidDestination`). */
  invalidDestination: boolean;
  /** The response's `data` (or body). */
  data: Record<string, unknown>;
}

function unwrap(payload: unknown): Record<string, unknown> {
  const body = record(payload) ?? {};
  return record(body.data) ?? body;
}

/** Telnyx TeXML REST client: places outbound calls and looks them up. */
export class TelnyxTexmlClient {
  readonly #options: TelnyxTexmlClientOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: TelnyxTexmlClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  #callsUrl(): string {
    const base = this.#options.baseUrl ?? TELNYX_API;
    return `${base}/texml/Accounts/${encodeURIComponent(this.#options.accountSid)}/Calls`;
  }

  #signal(signal: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout((this.#options.timeout ?? 20) * 1000);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  /**
   * Place an outbound call. Telnyx fetches `url` for the call's TeXML once it is answered.
   *
   * @throws TelnyxCallRejectedError if Telnyx refuses the call (a 4xx, or a destination that is
   *   not E.164). A 5xx throws a plain `Error`: the call may still have been placed.
   */
  async dial(options: TelnyxDialOptions): Promise<TelnyxCall> {
    if (!E164.test(options.to)) {
      throw new TelnyxCallRejectedError("Destination must be an E.164 phone number", {
        invalidDestination: true,
      });
    }
    const from = options.from ?? this.#options.from;
    if (!from) throw new Error("dial() needs a caller id: pass `from` here or to the client");
    const body: Record<string, unknown> = {
      ApplicationSid: this.#options.applicationSid,
      To: options.to,
      From: from,
      Url: options.url,
    };
    if (options.method) body.UrlMethod = options.method;
    if (options.statusCallback) {
      body.StatusCallback = options.statusCallback;
      body.StatusCallbackMethod = "POST";
      body.StatusCallbackEvent = (
        options.statusCallbackEvents ?? ["initiated", "ringing", "answered", "completed"]
      ).join(" ");
    }
    Object.assign(body, options.extra);

    const response = await this.#fetch(this.#callsUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#options.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: this.#signal(options.signal),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = `Telnyx rejected the call (${response.status})`;
      if (response.status >= 500) throw new Error(message);
      throw new TelnyxCallRejectedError(message, {
        status: response.status,
        invalidDestination: isInvalidDestination(payload),
        response: payload,
      });
    }
    return this.#call(payload);
  }

  /** Look up a call by its `CallSid`. */
  async getCall(callSid: string, options: { signal?: AbortSignal } = {}): Promise<TelnyxCall> {
    const response = await this.#fetch(`${this.#callsUrl()}/${encodeURIComponent(callSid)}`, {
      headers: { Authorization: `Bearer ${this.#options.apiKey}`, Accept: "application/json" },
      signal: this.#signal(options.signal),
    });
    if (!response.ok) throw new Error(`Telnyx call lookup failed (${response.status})`);
    return this.#call(await response.json());
  }

  #call(payload: unknown): TelnyxCall {
    const data = unwrap(payload);
    const callSid = data.call_control_id ?? data.call_sid ?? data.sid;
    if (typeof callSid !== "string" || !callSid) {
      throw new Error("Telnyx response did not include a call identifier");
    }
    return {
      callSid,
      status: typeof data.status === "string" ? data.status : null,
      invalidDestination: isInvalidDestination(data),
      data,
    };
  }
}
