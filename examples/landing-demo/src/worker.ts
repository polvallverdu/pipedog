// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The Worker: the demo page and its API, on one origin.
//
//   GET  /api/status                        is the demo on, which transports, Turnstile's site key
//   POST /api/session                       Turnstile token in, session ticket out (60 s, single use)
//   GET  /api/session/<id>/ws?ticket=       WebSocket session, to the session's Durable Object
//   POST /api/session/<id>/rtc/offer?ticket=  WebRTC session (Cloudflare Realtime): publish the mic
//   POST /api/session/<id>/rtc/connect|answer|hangup, GET .../rtc/messages   (call token)
//   GET  /api/session/<id>/rtc/media/input|output   the SFU's adapters (adapter token)
//   everything else                         the page (SvelteKit, from Workers Static Assets)
//
// The API takes requests from the demo's own origin (and ALLOWED_ORIGINS, for development); the
// SFU's adapter sockets are checked by token instead. The page may be framed only by itself and
// FRAME_ANCESTORS (the docs site). See security.ts for the tickets, ledger.ts for the budget.

import { type DemoConfig, type Env, readConfig } from "./config.ts";
import type { Refusal } from "./ledger.ts";
import {
  corsHeaders,
  hashIp,
  isAllowedOrigin,
  newSessionId,
  signTicket,
  TICKET_TTL_SECS,
  verifyTicket,
  verifyTurnstile,
} from "./security.ts";
import { CALL_TOKEN_HEADER, SESSION_HEADER, VISITOR_HEADER } from "./session.ts";

export { DemoBudget } from "./budget.ts";
export type { Env } from "./config.ts";
export { DemoSession } from "./session.ts";

const SESSION_PATH = /^\/api\/session\/([A-Za-z0-9_-]{16,64})\/(ws|rtc\/[a-z/]+)$/;
const RTC_ACTIONS = new Set([
  "rtc/offer",
  "rtc/connect",
  "rtc/answer",
  "rtc/hangup",
  "rtc/messages",
]);
const MEDIA_ACTIONS = new Set(["rtc/media/input", "rtc/media/output"]);

type RefusalReason =
  | Refusal
  | "disabled"
  | "rate_limited"
  | "turnstile"
  | "origin"
  | "webrtc_unavailable";

/** What the page shows when a session is refused, by reason. */
export const REFUSALS: Record<RefusalReason, string> = {
  disabled: "The demo is switched off for now. Check back later!",
  origin: "This page can't start demo sessions.",
  turnstile: "We couldn't check that you're human. Reload the page and try again.",
  rate_limited: "You've started a few sessions in a row. Give it a few minutes.",
  ip_limit: "You've started a few sessions in a row. Give it a few minutes.",
  busy: "The demo is busy with other visitors. Try again in a minute.",
  daily_sessions: "The demo has used up today's budget. Come back tomorrow!",
  daily_minutes: "The demo has used up today's budget. Come back tomorrow!",
  webrtc_unavailable: "WebRTC isn't set up on this demo. Use WebSocket instead.",
};

function json(data: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function refuse(reason: RefusalReason, status: number, headers: HeadersInit): Response {
  return json({ error: reason, message: REFUSALS[reason] }, status, headers);
}

/** Where the visitor entered Cloudflare's network. Shown to the visitor only; never logged. */
function visitorOf(request: Request): {
  colo: string | null;
  country: string | null;
  city: string | null;
} {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf ?? {};
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  return { colo: str(cf.colo), country: str(cf.country), city: str(cf.city) };
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** The origins allowed to use the API: the demo's own, and ALLOWED_ORIGINS. */
function allowedOrigins(request: Request, config: DemoConfig): string[] {
  return [new URL(request.url).origin, ...config.allowedOrigins];
}

async function createSession(
  request: Request,
  env: Env,
  config: DemoConfig,
  cors: HeadersInit,
): Promise<Response> {
  let token = "";
  let transport = "websocket";
  try {
    const body = (await request.json()) as { turnstileToken?: unknown; transport?: unknown };
    token = typeof body.turnstileToken === "string" ? body.turnstileToken : "";
    if (body.transport === "webrtc") transport = "webrtc";
  } catch {
    return json({ error: "bad_request", message: "Expected a JSON body." }, 400, cors);
  }
  if (transport === "webrtc" && !config.webrtc) return refuse("webrtc_unavailable", 400, cors);

  const ip = clientIp(request);
  const ipHash = await hashIp(ip, env.SESSION_SIGNING_KEY);

  // Burst limit per IP (hashed), by the Rate Limiting binding.
  if (env.SESSION_RATE_LIMITER) {
    const { success } = await env.SESSION_RATE_LIMITER.limit({ key: ipHash });
    if (!success) return refuse("rate_limited", 429, cors);
  }

  // Dev mode without a Turnstile secret is the local bypass; everything else is verified.
  if (!(config.devMode && !env.TURNSTILE_SECRET_KEY)) {
    const human =
      Boolean(env.TURNSTILE_SECRET_KEY) &&
      (await verifyTurnstile(token, {
        secret: env.TURNSTILE_SECRET_KEY ?? "",
        ip: ip === "unknown" ? null : ip,
        url: config.urls.turnstileVerify,
      }));
    if (!human) return refuse("turnstile", 403, cors);
  }

  const sessionId = newSessionId();
  const reservation = await env.DEMO_BUDGET.getByName("global").reserve(sessionId, ipHash);
  if (!reservation.ok) {
    return refuse(reservation.reason, reservation.reason === "busy" ? 503 : 429, cors);
  }

  const ticket = await signTicket(
    { sid: sessionId, ip: ipHash, exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECS },
    env.SESSION_SIGNING_KEY,
  );
  const url = new URL(request.url);
  const wsUrl = new URL(url);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = `/api/session/${sessionId}/ws`;
  wsUrl.search = new URLSearchParams({ ticket }).toString();
  return json(
    {
      sessionId,
      transport,
      ticket,
      // WebSocket: the socket to open. WebRTC: the base of the signaling routes.
      wsUrl: wsUrl.toString(),
      rtcUrl: `${url.origin}/api/session/${sessionId}/rtc`,
      expiresIn: TICKET_TTL_SECS,
      limits: { maxSecs: config.session.maxSecs, maxTurns: config.session.maxTurns },
    },
    200,
    cors,
  );
}

/** Copy only what the session needs from the browser's request, plus the Worker's own headers. */
function forwardHeaders(request: Request, extra: Record<string, string> = {}): Headers {
  const headers = new Headers();
  for (const name of [
    "upgrade",
    "connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "content-type",
    CALL_TOKEN_HEADER,
  ]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

async function forward(
  request: Request,
  env: Env,
  sessionId: string,
  headers: Headers,
  cors: HeadersInit = {},
): Promise<Response> {
  const response = await env.DEMO_SESSION.getByName(sessionId).fetch(
    new Request(request.url, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    }),
  );
  if (response.status === 101) return response;
  // Plain responses get the CORS headers (they carry none from the Durable Object).
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(cors)) out.headers.set(name, value);
  return out;
}

async function sessionRoute(
  request: Request,
  env: Env,
  config: DemoConfig,
  sessionId: string,
  action: string,
  cors: HeadersInit,
): Promise<Response> {
  // The SFU dials the media sockets: no Origin; the session checks the adapter token.
  if (MEDIA_ACTIONS.has(action) && request.method === "GET") {
    return await forward(request, env, sessionId, forwardHeaders(request));
  }
  const isWs = action === "ws" && request.method === "GET";
  if (!isWs && !RTC_ACTIONS.has(action)) return new Response("not found", { status: 404 });

  if (!isAllowedOrigin(request.headers.get("origin"), allowedOrigins(request, config))) {
    return refuse("origin", 403, cors);
  }
  if (!config.enabled) return refuse("disabled", 503, cors);

  // The requests that claim the session present the ticket; the others the call token.
  if (isWs || action === "rtc/offer") {
    if (action === "rtc/offer" && !config.webrtc) return refuse("webrtc_unavailable", 400, cors);
    const ipHash = await hashIp(clientIp(request), env.SESSION_SIGNING_KEY);
    const check = await verifyTicket(new URL(request.url).searchParams.get("ticket"), {
      secret: env.SESSION_SIGNING_KEY,
      sid: sessionId,
      ipHash,
    });
    if (!check.ok) {
      return json({ error: "ticket", message: `Invalid ticket (${check.reason}).` }, 401, cors);
    }
    return await forward(
      request,
      env,
      sessionId,
      forwardHeaders(request, {
        [SESSION_HEADER]: sessionId,
        [VISITOR_HEADER]: JSON.stringify(visitorOf(request)),
      }),
      cors,
    );
  }
  return await forward(request, env, sessionId, forwardHeaders(request), cors);
}

/** The page, with headers that keep it from being framed by anyone but the docs. */
async function page(request: Request, env: Env, config: DemoConfig): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const out = new Response(response.body, response);
  const ancestors = ["'self'", ...config.frameAncestors].join(" ");
  out.headers.set("content-security-policy", `frame-ancestors ${ancestors}`);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  out.headers.set("permissions-policy", "microphone=(self), camera=()");
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = readConfig(env);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return await page(request, env, config);

    const origin = request.headers.get("origin");
    const allowed = allowedOrigins(request, config);
    const cors = corsHeaders(origin, allowed);

    if (!env.SESSION_SIGNING_KEY) {
      console.error("SESSION_SIGNING_KEY is not set");
      return json({ error: "misconfigured", message: REFUSALS.disabled }, 503, cors);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: isAllowedOrigin(origin, allowed) ? 204 : 403,
        headers: cors,
      });
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return json(
        {
          enabled: config.enabled,
          transports: { websocket: true, webrtc: config.webrtc },
          turnstileSiteKey: config.turnstileSiteKey,
          // Without a site key, only dev mode can start sessions (no Turnstile).
          turnstileRequired: !(config.devMode && !env.TURNSTILE_SECRET_KEY),
          limits: { maxSecs: config.session.maxSecs, maxTurns: config.session.maxTurns },
        },
        200,
        cors,
      );
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      if (!isAllowedOrigin(origin, allowed)) return refuse("origin", 403, cors);
      if (!config.enabled) return refuse("disabled", 503, cors);
      return await createSession(request, env, config, cors);
    }

    const match = SESSION_PATH.exec(url.pathname);
    if (match) return await sessionRoute(request, env, config, match[1]!, match[2]!, cors);

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
