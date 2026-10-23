// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// What stands between the internet and the bot:
//
// - an origin allowlist, on the ticket endpoint and on the WebSocket upgrade, with CORS only for
//   allowed origins;
// - Cloudflare Turnstile, verified with siteverify before a session is handed out;
// - session tickets: short-lived, HMAC-signed, bound to the session id and the visitor's IP (as a
//   keyed hash), and single use (the session's Durable Object accepts one connection, ever).
//
// IPs are never stored or logged: only an HMAC of the IP, keyed with the signing key, is used, as
// the rate limiting key and in the ticket.

const encoder = new TextEncoder();

/** How long a ticket is valid, in seconds. */
export const TICKET_TTL_SECS = 60;

/** Whether `origin` is in the allowlist (exact match, scheme and port included). */
export function isAllowedOrigin(origin: string | null, allowed: readonly string[]): boolean {
  if (!origin) return false;
  return allowed.includes(origin.replace(/\/+$/, ""));
}

/** CORS headers for an allowed origin, or none. */
export function corsHeaders(origin: string | null, allowed: readonly string[]): HeadersInit {
  if (!origin || !isAllowedOrigin(origin, allowed)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Demo-Call-Token",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** A keyed hash of the visitor's IP: stable per IP and key, not reversible without the key. */
export async function hashIp(ip: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`ip:${ip}`));
  return base64url(new Uint8Array(mac).slice(0, 16));
}

/** A new random session id. */
export function newSessionId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export interface TicketPayload {
  /** The session id. */
  sid: string;
  /** The keyed hash of the IP the ticket was issued to. */
  ip: string;
  /** Expiry, in Unix seconds. */
  exp: number;
}

/** Sign a ticket: `base64url(payload).base64url(hmac)`. */
export async function signTicket(payload: TicketPayload, secret: string): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`ticket.${body}`));
  return `${body}.${base64url(new Uint8Array(mac))}`;
}

export type TicketCheck =
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "session" | "ip" };

/**
 * Check a ticket for the session `sid`, presented from the IP whose hash is `ipHash`.
 * Single use is enforced by the session's Durable Object, not here.
 */
export async function verifyTicket(
  ticket: string | null,
  options: { secret: string; sid: string; ipHash: string; now?: number },
): Promise<TicketCheck> {
  if (!ticket) return { ok: false, reason: "malformed" };
  const [body, mac, extra] = ticket.split(".");
  if (!body || !mac || extra !== undefined) return { ok: false, reason: "malformed" };
  let signature: Uint8Array<ArrayBuffer>;
  let payload: TicketPayload;
  try {
    signature = fromBase64url(mac);
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as TicketPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const key = await hmacKey(options.secret);
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`ticket.${body}`),
  );
  if (!valid) return { ok: false, reason: "signature" };
  if (
    typeof payload?.sid !== "string" ||
    typeof payload.ip !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  const now = options.now ?? Date.now() / 1000;
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  if (payload.sid !== options.sid) return { ok: false, reason: "session" };
  if (payload.ip !== options.ipHash) return { ok: false, reason: "ip" };
  return { ok: true, payload };
}

/** Verify a Turnstile token with siteverify. */
export async function verifyTurnstile(
  token: string,
  options: { secret: string; ip: string | null; url: string; fetch?: typeof fetch },
): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const body = new FormData();
  body.append("secret", options.secret);
  body.append("response", token);
  if (options.ip) body.append("remoteip", options.ip);
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(options.url, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}
