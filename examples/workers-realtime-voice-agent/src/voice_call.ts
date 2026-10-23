// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// One call. The Durable Object does the signaling for the browser, holds the call's Cloudflare
// Realtime resources, accepts the sockets the SFU dials, and runs the voice agent.
//
// Routes, under /api/call/<id>/:
//
//   POST offer     {sessionDescription, mid}  the browser publishes its microphone
//   POST connect                              the SFU attaches the bot; returns the SFU's offer
//   POST answer    {sessionDescription}       the browser's answer to that offer
//   GET  messages  (WebSocket)                RTVI messages between the browser and the bot
//   GET  media/input?token=…   (WebSocket)    the SFU streams the user's audio here
//   GET  media/output?token=…  (WebSocket)    the SFU takes the bot's audio from here
//   POST hangup                               end the call
//
// This example has no user authentication: anyone who can reach the Worker can start a call
// (and spend your OpenAI and Realtime usage). Put your own auth in front before deploying it
// publicly. The SFU's own requests are authenticated with a per-call token in the URL.

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
import { startVoiceAgent, type VoiceAgent } from "./bot.ts";
import type { Env } from "./worker.ts";

/** Storage key for resources still to release, so an alarm can retry the cleanup. */
const CLEANUP_KEY = "cleanup";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function isDescription(
  value: unknown,
  type: SessionDescription["type"],
): value is SessionDescription {
  const v = value as SessionDescription | null;
  return !!v && v.type === type && typeof v.sdp === "string";
}

/** Constant-time string comparison, for the adapter token. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class VoiceCall extends DurableObject<Env> {
  #call: CloudflareRealtimeCall | null = null;
  #transport: CloudflareRealtimeTransport | null = null;
  #token: string | null = null;
  #agent: VoiceAgent | null = null;
  #ended = false;

  #api(): CloudflareRealtimeAPI {
    return new CloudflareRealtimeAPI({
      appId: this.env.CLOUDFLARE_REALTIME_APP_ID,
      appSecret: this.env.CLOUDFLARE_REALTIME_APP_SECRET,
      baseUrl: this.env.CLOUDFLARE_REALTIME_API_URL,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/api\/call\/[^/]+\//, "");
    try {
      switch (`${request.method} ${action}`) {
        case "POST offer":
          return await this.#offer(request);
        case "POST connect":
          return await this.#connect(url);
        case "POST answer":
          return await this.#answer(request);
        case "POST hangup":
          await this.#end();
          return json({ ended: true });
        case "GET messages":
          if (!this.#transport || this.#ended) return json({ error: "no call" }, 404);
          return this.#transport.acceptSocket("messages", request);
        case "GET media/input":
        case "GET media/output": {
          const token = url.searchParams.get("token") ?? "";
          if (!this.#transport || !this.#token || this.#ended || !sameToken(token, this.#token)) {
            return json({ error: "forbidden" }, 403);
          }
          return this.#transport.acceptSocket(
            action === "media/input" ? "input" : "output",
            request,
          );
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      console.error(`call ${action} failed`, e);
      await this.#end();
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }

  /** The browser's microphone offer: publish it, and start the bot. */
  async #offer(request: Request): Promise<Response> {
    if (this.#call) return json({ error: "this call already started" }, 409);
    const body = (await request.json()) as { sessionDescription?: unknown; mid?: unknown };
    if (!isDescription(body.sessionDescription, "offer") || typeof body.mid !== "string") {
      return json({ error: "expected {sessionDescription: offer, mid}" }, 400);
    }

    this.#call = new CloudflareRealtimeCall(this.#api());
    this.#token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    // The transport exists before the SFU dials it; the pipeline starts now, while the browser
    // connects, and waits for the sockets.
    const transport = new CloudflareRealtimeTransport(
      new CloudflareRealtimeParams({ audioInEnabled: true, audioOutEnabled: true }),
    );
    this.#transport = transport;
    this.#agent = startVoiceAgent(transport, this.env);
    // When the user leaves, the agent stops; then release the call.
    this.ctx.waitUntil(
      this.#agent.done
        .catch((e) => console.error("voice agent failed", e))
        .finally(() => this.#end()),
    );

    const published = await this.#call.publishUser(body.sessionDescription, body.mid);
    await this.#saveCleanup();
    return json({ sessionDescription: published.sessionDescription });
  }

  /** The browser is connected: attach the bot, and offer the browser the bot's track. */
  async #connect(url: URL): Promise<Response> {
    if (!this.#call || !this.#token || this.#ended) return json({ error: "no call" }, 404);
    const base = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${url.pathname.replace(/connect$/, "media")}`;
    const token = encodeURIComponent(this.#token);
    const offer = await this.#call.connectBot({
      input: `${base}/input?token=${token}`,
      output: `${base}/output?token=${token}`,
    });
    await this.#saveCleanup();
    return json({ sessionDescription: offer.sessionDescription });
  }

  /** The browser's answer to the bot's track. */
  async #answer(request: Request): Promise<Response> {
    if (!this.#call || this.#ended) return json({ error: "no call" }, 404);
    const body = (await request.json()) as { sessionDescription?: unknown };
    if (!isDescription(body.sessionDescription, "answer")) {
      return json({ error: "expected {sessionDescription: answer}" }, 400);
    }
    await this.#call.renegotiate(body.sessionDescription);
    return json({ ok: true });
  }

  async #saveCleanup(): Promise<void> {
    if (this.#call) await this.ctx.storage.put(CLEANUP_KEY, this.#call.state);
  }

  /** End the call: stop the bot, refuse the SFU's reconnects, release the SFU resources. */
  async #end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    this.#token = null;
    // Stopping the agent closes the transport's sockets.
    await this.#agent?.stop();
    if (this.#call && !(await this.#call.close())) {
      // Retry what is left from an alarm.
      await this.#saveCleanup();
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    await this.ctx.storage.delete(CLEANUP_KEY);
  }

  /** Retry releasing what a call left behind. */
  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<CloudflareRealtimeCallState>(CLEANUP_KEY);
    if (!state) return;
    const call = new CloudflareRealtimeCall(this.#api(), { state });
    if (await call.close()) {
      await this.ctx.storage.delete(CLEANUP_KEY);
    } else {
      await this.ctx.storage.put(CLEANUP_KEY, call.state);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }
}
