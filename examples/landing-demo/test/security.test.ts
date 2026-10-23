// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { describe, expect, test } from "bun:test";
import { type Env, readConfig } from "../src/config.ts";
import {
  corsHeaders,
  hashIp,
  isAllowedOrigin,
  newSessionId,
  signTicket,
  TICKET_TTL_SECS,
  verifyTicket,
  verifyTurnstile,
} from "../src/security.ts";

const SECRET = "signing-key";
const ALLOWED = ["https://polvallverdu.github.io", "http://localhost:3000"];

describe("origins", () => {
  test("only exact allowed origins pass", () => {
    expect(isAllowedOrigin("https://polvallverdu.github.io", ALLOWED)).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", ALLOWED)).toBe(true);
    expect(isAllowedOrigin("http://localhost:3001", ALLOWED)).toBe(false);
    expect(isAllowedOrigin("https://polvallverdu.github.io.evil.test", ALLOWED)).toBe(false);
    expect(isAllowedOrigin("http://polvallverdu.github.io", ALLOWED)).toBe(false);
    expect(isAllowedOrigin(null, ALLOWED)).toBe(false);
    expect(isAllowedOrigin("null", ALLOWED)).toBe(false);
  });

  test("CORS headers are only given to allowed origins", () => {
    const ok = new Headers(corsHeaders("http://localhost:3000", ALLOWED));
    expect(ok.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(ok.get("vary")).toBe("Origin");
    const no = new Headers(corsHeaders("https://evil.test", ALLOWED));
    expect(no.get("access-control-allow-origin")).toBeNull();
  });

  test("ALLOWED_ORIGINS is split and trimmed", () => {
    const config = readConfig({
      ALLOWED_ORIGINS: " https://a.test/ , http://localhost:3000",
    } as Env);
    expect(config.allowedOrigins).toEqual(["https://a.test", "http://localhost:3000"]);
  });
});

describe("tickets", () => {
  const now = 1_800_000_000;
  async function ticket(overrides: Partial<{ sid: string; ip: string; exp: number }> = {}) {
    return await signTicket(
      { sid: "session-1", ip: "ip-hash", exp: now + TICKET_TTL_SECS, ...overrides },
      SECRET,
    );
  }
  const check = (
    t: string | null,
    o: Partial<{ sid: string; ipHash: string; now: number; secret: string }> = {},
  ) => verifyTicket(t, { secret: SECRET, sid: "session-1", ipHash: "ip-hash", now, ...o });

  test("a ticket verifies for its session and IP", async () => {
    const result = await check(await ticket());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.sid).toBe("session-1");
  });

  test("an expired ticket is refused", async () => {
    expect(await check(await ticket(), { now: now + TICKET_TTL_SECS })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await check(await ticket(), { now: now + TICKET_TTL_SECS - 1 })).toMatchObject({
      ok: true,
    });
  });

  test("a ticket for another session or IP is refused", async () => {
    expect(await check(await ticket(), { sid: "session-2" })).toEqual({
      ok: false,
      reason: "session",
    });
    expect(await check(await ticket(), { ipHash: "other" })).toEqual({ ok: false, reason: "ip" });
  });

  test("a tampered or foreign ticket is refused", async () => {
    const t = await ticket();
    const [body, mac] = t.split(".");
    // Payload changed, signature kept.
    const forged = btoa(JSON.stringify({ sid: "session-1", ip: "ip-hash", exp: now + 3600 }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(await check(`${forged}.${mac}`)).toEqual({ ok: false, reason: "signature" });
    expect(await check(`${body}.${mac!.slice(0, -2)}AA`)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await check(t, { secret: "another-key" })).toEqual({ ok: false, reason: "signature" });
  });

  test("garbage is malformed", async () => {
    for (const t of [null, "", "abc", "a.b.c", "!!!.???"]) {
      expect((await check(t)).ok).toBe(false);
    }
  });

  test("IP hashes are stable, keyed and don't contain the IP", async () => {
    const a = await hashIp("203.0.113.7", SECRET);
    expect(a).toBe(await hashIp("203.0.113.7", SECRET));
    expect(a).not.toBe(await hashIp("203.0.113.8", SECRET));
    expect(a).not.toBe(await hashIp("203.0.113.7", "other-key"));
    expect(a).not.toContain("203");
  });

  test("session ids are random and URL safe", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("Turnstile", () => {
  test("siteverify is asked with the secret, the token and the IP", async () => {
    let sent: FormData | null = null;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = init.body as FormData;
      return Response.json({ success: true });
    }) as unknown as typeof fetch;
    const ok = await verifyTurnstile("tok", {
      secret: "s",
      ip: "203.0.113.7",
      url: "https://x.test",
      fetch: fakeFetch,
    });
    expect(ok).toBe(true);
    expect(sent!.get("secret")).toBe("s");
    expect(sent!.get("response")).toBe("tok");
    expect(sent!.get("remoteip")).toBe("203.0.113.7");
  });

  test("a failure, an error or an empty token is not a pass", async () => {
    const fail = (async () => Response.json({ success: false })) as unknown as typeof fetch;
    const broken = (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    const throws = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const opts = { secret: "s", ip: null, url: "https://x.test" };
    expect(await verifyTurnstile("tok", { ...opts, fetch: fail })).toBe(false);
    expect(await verifyTurnstile("tok", { ...opts, fetch: broken })).toBe(false);
    expect(await verifyTurnstile("tok", { ...opts, fetch: throws })).toBe(false);
    expect(await verifyTurnstile("", { ...opts, fetch: fail })).toBe(false);
  });
});

describe("config", () => {
  test("the kill switch is off unless DEMO_ENABLED is exactly true", () => {
    expect(readConfig({ DEMO_ENABLED: "true" } as Env).enabled).toBe(true);
    expect(readConfig({ DEMO_ENABLED: "false" } as Env).enabled).toBe(false);
    expect(readConfig({ DEMO_ENABLED: "1" } as Env).enabled).toBe(false);
    expect(readConfig({} as Env).enabled).toBe(false);
  });

  test("test overrides are ignored outside dev mode", () => {
    const env = { ANTHROPIC_BASE_URL: "http://x", TRACE_URL: "http://fake/trace" } as Env;
    expect(readConfig(env).urls.trace).toBe("https://www.cloudflare.com/cdn-cgi/trace");
    expect(readConfig({ ...env, DEMO_DEV_MODE: "true" }).urls.trace).toBe("http://fake/trace");
    expect(readConfig({ ...env, DEMO_DEV_MODE: "yes" }).devMode).toBe(false);
  });

  test("limits default sensibly and ignore junk", () => {
    const config = readConfig({ SESSION_MAX_SECS: "abc", MAX_CONCURRENT_SESSIONS: "-2" } as Env);
    expect(config.session).toEqual({ maxSecs: 120, idleSecs: 30, maxTurns: 12 });
    expect(config.budget.maxConcurrent).toBe(4);
  });
});
