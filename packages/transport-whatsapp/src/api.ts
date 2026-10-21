// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/transports/whatsapp/api.py

/**
 * WhatsApp API.
 *
 * API to communicate with WhatsApp Cloud API. Only `fetch` is used, so this
 * module runs on Bun, Node, Deno and Cloudflare Workers.
 *
 * PORTING NOTES:
 * - Upstream's pydantic models become TypeScript interfaces plus
 *   `parseWebhookRequest()`, which validates a decoded webhook body by hand (a
 *   `ValidationError` upstream, a `WebhookValidationError` here). Property names are the
 *   wire's: `from` (upstream's `from_` field, aliased to `from`) and snake_case such as
 *   `sdp_type`, `start_time`.
 * - DIVERGENCE: `aiohttp.ClientSession` becomes an optional `fetch` option.
 * - Meta's current calling docs make some contact fields optional (`wa_id`,
 *   `profile`); the parser accepts that, where upstream's models require them.
 */

import { logger } from "@pipedog/core/utils/logger";

// ----------------------------
// Models for WhatsApp
// ----------------------------

/** WebRTC session information for WhatsApp calls. */
export interface WhatsAppSession {
  /** Session Description Protocol (SDP) data for WebRTC connection. */
  sdp: string;
  /** Type of SDP (e.g., "offer", "answer"). */
  sdp_type: string;
}

/** Error information from WhatsApp API responses. */
export interface WhatsAppError {
  code: number;
  message: string;
  href: string;
  error_data: Record<string, unknown>;
}

/**
 * Incoming call connection event data.
 *
 * Represents a user-initiated call that requires handling. This is sent
 * when a WhatsApp user initiates a call to your business number.
 */
export interface WhatsAppConnectCall {
  /** Unique call identifier. */
  id: string;
  /** Phone number of the caller (WhatsApp ID format). Upstream: `from_`. */
  from: string;
  /** Your business phone number that received the call. */
  to: string;
  /** Always "connect" for incoming calls. */
  event: string;
  /** ISO 8601 timestamp when the call was initiated. */
  timestamp: string;
  /** Optional call direction ("USER_INITIATED" for user-initiated calls). */
  direction: string | null;
  /** WebRTC session data containing SDP offer from the caller. */
  session: WhatsAppSession;
}

/**
 * Call termination event data.
 *
 * Represents the end of a call session, whether completed successfully,
 * failed, or was rejected by either party.
 */
export interface WhatsAppTerminateCall {
  /** Unique call identifier (matches the connect event). */
  id: string;
  /** Phone number of the caller. Upstream: `from_`. */
  from: string;
  /** Your business phone number. */
  to: string;
  /** Always "terminate" for call end events. */
  event: string;
  timestamp: string;
  direction: string | null;
  /** Optional business-specific callback data. */
  biz_opaque_callback_data?: string | null;
  /** Call completion status ("FAILED", "COMPLETED", "REJECTED"). */
  status?: string | null;
  /** ISO 8601 timestamp when call actually started (after acceptance). */
  start_time?: string | null;
  end_time?: string | null;
  /** Call duration in seconds (only for completed calls). */
  duration?: number | null;
}

/** User profile information. */
export interface WhatsAppProfile {
  /** Display name of the WhatsApp user. */
  name: string;
}

/** Contact information for a WhatsApp user. */
export interface WhatsAppContact {
  profile?: WhatsAppProfile;
  /** WhatsApp ID (phone number in international format without +). */
  wa_id?: string;
}

/** Business phone number metadata. */
export interface WhatsAppMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

/** Webhook payload for incoming call events. */
export interface WhatsAppConnectCallValue {
  messaging_product: string;
  metadata: WhatsAppMetadata;
  contacts: WhatsAppContact[];
  calls: WhatsAppConnectCall[];
}

/** Webhook payload for call termination events. */
export interface WhatsAppTerminateCallValue {
  messaging_product: string;
  metadata: WhatsAppMetadata;
  calls: WhatsAppTerminateCall[];
  errors?: WhatsAppError[] | null;
}

/** Webhook change event wrapper. */
export interface WhatsAppChange {
  /** The actual event data (connect or terminate). */
  value: WhatsAppConnectCallValue | WhatsAppTerminateCallValue;
  /** Always "calls" for calling webhooks. */
  field: string;
}

/** Webhook entry containing one or more changes. */
export interface WhatsAppEntry {
  /** WhatsApp Business Account ID. */
  id: string;
  changes: WhatsAppChange[];
}

/**
 * Complete webhook request from WhatsApp: the top-level structure for all
 * webhook deliveries from the WhatsApp Cloud API for calling events.
 */
export interface WhatsAppWebhookRequest {
  /** Always "whatsapp_business_account". */
  object: string;
  entry: WhatsAppEntry[];
}

/** Whether a webhook value is a call-connect payload (it has contacts and call sessions). */
export function isConnectCallValue(
  value: WhatsAppChange["value"],
): value is WhatsAppConnectCallValue {
  return "contacts" in value && value.calls.every((c) => "session" in c);
}

/** Whether a webhook value is a call-terminate payload. */
export function isTerminateCallValue(
  value: WhatsAppChange["value"],
): value is WhatsAppTerminateCallValue {
  return !isConnectCallValue(value);
}

// ----------------------------
// Parsing (pydantic's validation)
// ----------------------------

/** A webhook body that does not have the expected structure. */
export class WebhookValidationError extends Error {
  override name = "WebhookValidationError";
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new WebhookValidationError(`${path}: expected an object`);
  }
  return v as Obj;
}

function str(o: Obj, key: string, path: string): string {
  if (typeof o[key] !== "string")
    throw new WebhookValidationError(`${path}.${key}: expected a string`);
  return o[key] as string;
}

function optStr(o: Obj, key: string, path: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new WebhookValidationError(`${path}.${key}: expected a string`);
  return v;
}

function arr(o: Obj, key: string, path: string): unknown[] {
  if (!Array.isArray(o[key])) throw new WebhookValidationError(`${path}.${key}: expected a list`);
  return o[key] as unknown[];
}

function parseMetadata(v: unknown, path: string): WhatsAppMetadata {
  const o = obj(v, path);
  return {
    display_phone_number: str(o, "display_phone_number", path),
    phone_number_id: str(o, "phone_number_id", path),
  };
}

function parseCallCommon(o: Obj, path: string) {
  return {
    id: str(o, "id", path),
    // Meta omits `from` for callers that use a username; the business-scoped user ID then identifies them.
    from: typeof o.from === "string" ? o.from : str(o, "from_user_id", path),
    to: str(o, "to", path),
    event: str(o, "event", path),
    timestamp: str(o, "timestamp", path),
    direction: optStr(o, "direction", path),
  };
}

function parseConnectCall(v: unknown, path: string): WhatsAppConnectCall {
  const o = obj(v, path);
  const session = obj(o.session, `${path}.session`);
  return {
    ...parseCallCommon(o, path),
    session: {
      sdp: str(session, "sdp", `${path}.session`),
      sdp_type: str(session, "sdp_type", `${path}.session`),
    },
  };
}

function parseTerminateCall(v: unknown, path: string): WhatsAppTerminateCall {
  const o = obj(v, path);
  const call: WhatsAppTerminateCall = parseCallCommon(o, path);
  call.biz_opaque_callback_data = optStr(o, "biz_opaque_callback_data", path);
  call.status = optStr(o, "status", path);
  call.start_time = optStr(o, "start_time", path);
  call.end_time = optStr(o, "end_time", path);
  if (o.duration !== undefined && o.duration !== null) {
    if (typeof o.duration !== "number")
      throw new WebhookValidationError(`${path}.duration: expected a number`);
    call.duration = o.duration;
  } else {
    call.duration = null;
  }
  return call;
}

function parseValue(v: unknown, path: string): WhatsAppChange["value"] {
  const o = obj(v, path);
  const messagingProduct = str(o, "messaging_product", path);
  const metadata = parseMetadata(o.metadata, `${path}.metadata`);
  const calls = arr(o, "calls", path);
  // Like pydantic's union, the connect model is tried first: it needs contacts and a session per call.
  if (
    Array.isArray(o.contacts) &&
    calls.every((c) => typeof c === "object" && c !== null && "session" in c)
  ) {
    return {
      messaging_product: messagingProduct,
      metadata,
      contacts: (o.contacts as unknown[]).map((c, i) => {
        const co = obj(c, `${path}.contacts[${i}]`);
        const contact: WhatsAppContact = {};
        if (co.profile !== undefined && co.profile !== null) {
          contact.profile = {
            name: str(
              obj(co.profile, `${path}.contacts[${i}].profile`),
              "name",
              `${path}.contacts[${i}].profile`,
            ),
          };
        }
        if (typeof co.wa_id === "string") contact.wa_id = co.wa_id;
        return contact;
      }),
      calls: calls.map((c, i) => parseConnectCall(c, `${path}.calls[${i}]`)),
    };
  }
  const errors = Array.isArray(o.errors)
    ? (o.errors as unknown[]).map((e, i) => {
        const eo = obj(e, `${path}.errors[${i}]`);
        if (typeof eo.code !== "number")
          throw new WebhookValidationError(`${path}.errors[${i}].code: expected a number`);
        return {
          code: eo.code,
          message: str(eo, "message", `${path}.errors[${i}]`),
          href: typeof eo.href === "string" ? eo.href : "",
          error_data:
            typeof eo.error_data === "object" && eo.error_data !== null
              ? (eo.error_data as Obj)
              : {},
        };
      })
    : null;
  return {
    messaging_product: messagingProduct,
    metadata,
    calls: calls.map((c, i) => parseTerminateCall(c, `${path}.calls[${i}]`)),
    errors,
  };
}

/**
 * Validate a decoded webhook body (`JSON.parse` of the raw request) as a
 * `WhatsAppWebhookRequest`. Unknown fields are dropped, as pydantic does.
 *
 * @throws WebhookValidationError If the body does not have the expected structure.
 */
export function parseWebhookRequest(body: unknown): WhatsAppWebhookRequest {
  const o = obj(body, "body");
  return {
    object: str(o, "object", "body"),
    entry: arr(o, "entry", "body").map((e, i) => {
      const eo = obj(e, `body.entry[${i}]`);
      return {
        id: str(eo, "id", `body.entry[${i}]`),
        changes: arr(eo, "changes", `body.entry[${i}]`).map((c, j) => {
          const path = `body.entry[${i}].changes[${j}]`;
          const co = obj(c, path);
          return { value: parseValue(co.value, `${path}.value`), field: str(co, "field", path) };
        }),
      };
    }),
  };
}

// ----------------------------
// API client
// ----------------------------

/** The result of a Graph API call: `{ messaging_product, success }`, or an `error` object. */
export type WhatsAppApiResponse = Record<string, unknown>;

export interface WhatsAppApiOptions {
  /** WhatsApp access token for authentication. */
  whatsappToken: string;
  /** Your business phone number ID from WhatsApp Business API. */
  phoneNumberId: string;
  /** A `fetch`-compatible function (default: the global `fetch`). Replaces upstream's aiohttp session. */
  fetch?: typeof fetch | null;
  /** Graph API base URL (default: `WhatsAppApi.BASE_URL`). */
  baseUrl?: string | null;
}

/**
 * WhatsApp Cloud API client for handling calls.
 *
 * This class provides methods to interact with the WhatsApp Cloud API
 * for managing voice calls, including answering, rejecting, and terminating calls.
 */
export class WhatsAppApi {
  /** Base URL for WhatsApp Graph API v23.0. */
  static readonly BASE_URL = "https://graph.facebook.com/v23.0/";

  protected _phoneNumberId: string;
  protected _fetch: typeof fetch;
  protected _baseUrl: string;
  protected _whatsappUrl: string;
  protected _whatsappToken: string;

  constructor(options: WhatsAppApiOptions) {
    this._phoneNumberId = options.phoneNumberId;
    this._fetch =
      options.fetch ?? (((input, init) => globalThis.fetch(input, init)) as typeof fetch);
    this._baseUrl = options.baseUrl ?? WhatsAppApi.BASE_URL;
    this._whatsappUrl = `${this._baseUrl}${options.phoneNumberId}/calls`;
    this._whatsappToken = options.whatsappToken;
  }

  /** Update the WhatsApp access token for authentication. */
  updateWhatsappToken(whatsappToken: string): void {
    this._whatsappToken = whatsappToken;
  }

  /**
   * Update the WhatsApp phone number ID for authentication.
   *
   * Upstream only stores the value (the calls URL is built once, in the constructor).
   * Here the URL follows it, which is what the method's name promises.
   */
  updateWhatsappPhoneNumberId(phoneNumberId: string): void {
    this._phoneNumberId = phoneNumberId;
    this._whatsappUrl = `${this._baseUrl}${phoneNumberId}/calls`;
  }

  async #post(body: Record<string, unknown>): Promise<WhatsAppApiResponse> {
    const response = await this._fetch(this._whatsappUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._whatsappToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return (await response.json()) as WhatsAppApiResponse;
  }

  /**
   * Answer an incoming WhatsApp call.
   *
   * This method handles the call answering process, supporting both "pre_accept"
   * and "accept" actions as required by the WhatsApp calling workflow.
   *
   * Calls must be pre-accepted before being accepted. The typical flow is:
   * 1. Receive connect webhook
   * 2. Call with action="pre_accept"
   * 3. Call with action="accept"
   *
   * @param callId Unique identifier for the call (from connect webhook).
   * @param action Action to perform ("pre_accept" or "accept").
   * @param sdp Session Description Protocol answer for WebRTC connection.
   * @param from Caller's phone number (WhatsApp ID format).
   * @returns The API response with success status and any error details.
   */
  async answerCallToWhatsapp(
    callId: string,
    action: string,
    sdp: string,
    from: string,
  ): Promise<WhatsAppApiResponse> {
    logger.debug(`Answering call ${callId} to WhatsApp, action:${action}`);
    return this.#post({
      messaging_product: "whatsapp",
      to: from,
      action,
      call_id: callId,
      session: { sdp, sdp_type: "answer" },
    });
  }

  /**
   * Reject an incoming WhatsApp call.
   *
   * Rejects a call that was received via connect webhook. The caller will
   * receive a rejection notification and a terminate webhook will be sent.
   * Call this instead of `answerCallToWhatsapp` to decline the incoming call.
   *
   * @param callId Unique identifier for the call (from connect webhook).
   */
  async rejectCallToWhatsapp(callId: string): Promise<WhatsAppApiResponse> {
    logger.debug(`Rejecting call ${callId}`);
    return this.#post({ messaging_product: "whatsapp", action: "reject", call_id: callId });
  }

  /**
   * Terminate an active WhatsApp call.
   *
   * Ends an ongoing call that has been previously accepted. Both parties will
   * be disconnected and a terminate webhook will be sent. Only for calls that
   * have been accepted; for incoming calls that haven't been, use
   * `rejectCallToWhatsapp`.
   *
   * @param callId Unique identifier for the active call.
   */
  async terminateCallToWhatsapp(callId: string): Promise<WhatsAppApiResponse> {
    logger.debug(`Terminating call ${callId}`);
    return this.#post({ messaging_product: "whatsapp", action: "terminate", call_id: callId });
  }
}
