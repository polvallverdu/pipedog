// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// One visitor session: a Durable Object named by the session id. It runs the agent over one of
// two transports, and is used once, ever (so a ticket can't be used twice):
//
//   WebSocket   GET  .../ws                       the browser's socket (Pipecat protobuf frames)
//   WebRTC      POST .../rtc/offer                the browser publishes its mic; the bot starts
//               POST .../rtc/connect              the SFU attaches the bot; returns its offer
//               POST .../rtc/answer               the browser's answer
//               POST .../rtc/hangup               end the session
//               GET  .../rtc/messages?token=      RTVI messages, browser <-> bot (WebSocket)
//               GET  .../rtc/media/input?token=   the SFU streams the user's audio here
//               GET  .../rtc/media/output?token=  the SFU takes the bot's audio from here
//
// The Worker has already checked the ticket for `ws` and `rtc/offer` (the requests that claim
// the session); it passes the session id and where the visitor connected from in headers it sets
// itself. A WebRTC session then hands the browser a call token (for connect, answer, hangup and
// the messages socket), and gives the SFU an adapter token (for the media sockets): both random,
// 256-bit, for this session only, and void once it ends.
//
// The object claims the session's slot in the budget, and releases it when the session ends. An
// alarm is the backstop: it stops a session that outlives the hard limit, retries releasing
// Realtime resources that failed to close, and finally clears the object's storage.

import { DurableObject } from "cloudflare:workers";
import {
  CloudflareRealtimeAPI,
  CloudflareRealtimeCall,
  type CloudflareRealtimeCallState,
  type SessionDescription,
} from "@pipedog/transport-cloudflare-realtime/api";
import {
  CloudflareRealtimeParams,
  CloudflareRealtimeTransport,
} from "@pipedog/transport-cloudflare-realtime/transport";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";
import {
  type DemoAgent,
  type DemoTransportKind,
  startDemoAgent,
  websocketTransport,
} from "./bot.ts";
import { type Env, readConfig } from "./config.ts";
import type { VisitorInfo } from "./tools.ts";

/** Headers the Worker sets on the requests it forwards. */
export const SESSION_HEADER = "x-demo-session";
export const VISITOR_HEADER = "x-demo-visitor";
/** The WebRTC call token, from the browser (the Worker passes it through). */
export const CALL_TOKEN_HEADER = "x-demo-call-token";

const USED_KEY = "used";
const CLEANUP_KEY = "realtime-cleanup";
/** How long a finished session's object keeps its "used" mark, in milliseconds. */
const CLEANUP_AFTER_MS = 10 * 60 * 1000;
/** Slack past the hard limit before the alarm stops a session, in milliseconds. */
const BACKSTOP_GRACE_MS = 30 * 1000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function parseVisitor(header: string | null): VisitorInfo {
  try {
    const v = JSON.parse(header ?? "{}") as Partial<VisitorInfo>;
    const str = (x: unknown) => (typeof x === "string" && x ? x.slice(0, 64) : null);
    return { colo: str(v.colo), country: str(v.country), city: str(v.city) };
  } catch {
    return { colo: null, country: null, city: null };
  }
}

function isDescription(
  value: unknown,
  type: SessionDescription["type"],
): value is SessionDescription {
  const v = value as SessionDescription | null;
  return !!v && v.type === type && typeof v.sdp === "string" && v.sdp.length < 20_000;
}

/** A random 256-bit token, hex. */
function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Constant-time comparison. */
function sameToken(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class DemoSession extends DurableObject<Env> {
  readonly #wsHandler = websocketFetchHandler((connection) =>
    this.#run(websocketTransport(connection), "websocket"),
  );
  #claimed = false;
  #sessionId: string | null = null;
  #visitor: VisitorInfo = { colo: null, country: null, city: null };
  #agent: DemoAgent | null = null;
  #ended = false;
  // WebRTC
  #call: CloudflareRealtimeCall | null = null;
  #rtc: CloudflareRealtimeTransport | null = null;
  #callToken: string | null = null;
  #adapterToken: string | null = null;

  #api(): CloudflareRealtimeAPI {
    const config = readConfig(this.env);
    return new CloudflareRealtimeAPI({
      appId: this.env.CLOUDFLARE_REALTIME_APP_ID ?? "",
      appSecret: this.env.CLOUDFLARE_REALTIME_APP_SECRET ?? "",
      baseUrl: config.realtimeApiUrl ?? undefined,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/api\/session\/[^/]+\//, "");
    try {
      switch (`${request.method} ${action}`) {
        case "GET ws":
          return await this.#openWebsocket(request);
        case "POST rtc/offer":
          return await this.#offer(request);
        case "POST rtc/connect":
          if (!this.#callAuthorized(request.headers.get(CALL_TOKEN_HEADER)))
            return json({ error: "forbidden" }, 403);
          return await this.#connect(url);
        case "POST rtc/answer":
          if (!this.#callAuthorized(request.headers.get(CALL_TOKEN_HEADER)))
            return json({ error: "forbidden" }, 403);
          return await this.#answer(request);
        case "POST rtc/hangup":
          if (!this.#callAuthorized(request.headers.get(CALL_TOKEN_HEADER)))
            return json({ error: "forbidden" }, 403);
          await this.#agent?.stop();
          return json({ ended: true });
        case "GET rtc/messages":
          // Browsers can't set headers on a WebSocket: the call token is in the query.
          if (!this.#callAuthorized(url.searchParams.get("token")))
            return json({ error: "forbidden" }, 403);
          return this.#rtc!.acceptSocket("messages", request);
        case "GET rtc/media/input":
        case "GET rtc/media/output":
          if (
            !this.#rtc ||
            this.#ended ||
            !sameToken(url.searchParams.get("token"), this.#adapterToken)
          ) {
            return json({ error: "forbidden" }, 403);
          }
          return this.#rtc.acceptSocket(action.endsWith("input") ? "input" : "output", request);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      console.error(`session ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.#agent?.stop();
      return json({ error: "The session failed to start." }, 502);
    }
  }

  #callAuthorized(token: string | null): boolean {
    return !!this.#rtc && !this.#ended && sameToken(token, this.#callToken);
  }

  /**
   * Claim the session: once per object, ever, and only with a reservation in the budget.
   * Returns a refusal, or null when the session is ours.
   */
  async #claim(request: Request): Promise<Response | null> {
    // Claimed before the first await, so two requests racing for the session can't both pass.
    if (this.#claimed) return json({ error: "This session was already used." }, 409);
    this.#claimed = true;
    if (await this.ctx.storage.get<boolean>(USED_KEY)) {
      return json({ error: "This session was already used." }, 409);
    }
    await this.ctx.storage.put(USED_KEY, true);

    const sessionId = request.headers.get(SESSION_HEADER);
    if (!sessionId) return json({ error: "Missing session." }, 400);
    const started = await this.env.DEMO_BUDGET.getByName("global").start(sessionId);
    if (!started) return json({ error: "This session has expired." }, 403);

    this.#sessionId = sessionId;
    this.#visitor = parseVisitor(request.headers.get(VISITOR_HEADER));
    const { session } = readConfig(this.env);
    await this.ctx.storage.setAlarm(Date.now() + session.maxSecs * 1000 + BACKSTOP_GRACE_MS);
    return null;
  }

  async #openWebsocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("This endpoint takes WebSocket connections.", { status: 426 });
    }
    const refused = await this.#claim(request);
    if (refused) return refused;
    return await this.#wsHandler(request);
  }

  /** Start the agent on `transport` and wait for it; then release everything. */
  async #run(
    transport: Parameters<typeof startDemoAgent>[0],
    kind: DemoTransportKind,
  ): Promise<void> {
    const config = readConfig(this.env);
    const agent = startDemoAgent(transport, this.env, config, {
      sessionId: this.#sessionId ?? "",
      visitor: this.#visitor,
      transport: kind,
    });
    this.#agent = agent;
    try {
      await agent.done;
    } catch (e) {
      console.error(`session failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await this.#finish();
    }
  }

  /** The browser's microphone offer: create the Realtime call, publish it, start the bot. */
  async #offer(request: Request): Promise<Response> {
    if (!readConfig(this.env).webrtc) return json({ error: "WebRTC is not available." }, 400);
    const body = (await request.json().catch(() => ({}))) as {
      sessionDescription?: unknown;
      mid?: unknown;
    };
    if (!isDescription(body.sessionDescription, "offer") || typeof body.mid !== "string") {
      return json({ error: "expected {sessionDescription: offer, mid}" }, 400);
    }
    const refused = await this.#claim(request);
    if (refused) return refused;

    this.#call = new CloudflareRealtimeCall(this.#api());
    this.#callToken = newToken();
    this.#adapterToken = newToken();
    // The transport exists before the SFU dials it: the pipeline starts now, while the browser
    // connects, and waits for the sockets.
    this.#rtc = new CloudflareRealtimeTransport(
      new CloudflareRealtimeParams({ audioInEnabled: true, audioOutEnabled: true }),
    );
    this.ctx.waitUntil(this.#run(this.#rtc, "webrtc"));

    const published = await this.#call.publishUser(body.sessionDescription, body.mid);
    await this.#saveCleanup();
    return json({ sessionDescription: published.sessionDescription, callToken: this.#callToken });
  }

  /** The browser is connected: attach the bot, and offer the browser the bot's track. */
  async #connect(url: URL): Promise<Response> {
    if (!this.#call || !this.#adapterToken) return json({ error: "no call" }, 404);
    const media = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${url.pathname.replace(/connect$/, "media")}`;
    const token = encodeURIComponent(this.#adapterToken);
    const offer = await this.#call.connectBot({
      input: `${media}/input?token=${token}`,
      output: `${media}/output?token=${token}`,
    });
    await this.#saveCleanup();
    return json({ sessionDescription: offer.sessionDescription });
  }

  async #answer(request: Request): Promise<Response> {
    if (!this.#call) return json({ error: "no call" }, 404);
    const body = (await request.json().catch(() => ({}))) as { sessionDescription?: unknown };
    if (!isDescription(body.sessionDescription, "answer")) {
      return json({ error: "expected {sessionDescription: answer}" }, 400);
    }
    await this.#call.renegotiate(body.sessionDescription);
    return json({ ok: true });
  }

  async #saveCleanup(): Promise<void> {
    if (this.#call) await this.ctx.storage.put(CLEANUP_KEY, this.#call.state);
  }

  /** The session ended (any way): void the tokens, release the call and the budget slot. */
  async #finish(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    this.#callToken = null;
    this.#adapterToken = null;
    this.#agent = null;
    await this.env.DEMO_BUDGET.getByName("global").finish(this.#sessionId ?? "");
    if (this.#call && !(await this.#call.close())) {
      // Retry what is left from the alarm.
      await this.#saveCleanup();
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    await this.ctx.storage.delete(CLEANUP_KEY);
    await this.ctx.storage.setAlarm(Date.now() + CLEANUP_AFTER_MS);
  }

  /** The backstop while a session runs; afterwards, Realtime cleanup and the storage. */
  override async alarm(): Promise<void> {
    if (this.#agent) {
      // Still running past the hard limit: stop it (#finish follows).
      await this.#agent.stop();
      return;
    }
    const state = await this.ctx.storage.get<CloudflareRealtimeCallState>(CLEANUP_KEY);
    if (state) {
      const call = new CloudflareRealtimeCall(this.#api(), { state });
      if (!(await call.close())) {
        await this.ctx.storage.put(CLEANUP_KEY, call.state);
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      }
    }
    // The ticket expired long ago and the budget slot is gone, so the "used" mark can go too.
    await this.ctx.storage.deleteAll();
  }
}
