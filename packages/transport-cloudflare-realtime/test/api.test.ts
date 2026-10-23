// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// CloudflareRealtimeAPI and CloudflareRealtimeCall against a fake Realtime API (an injected
// fetch). The last block talks to the real API, and only runs when
// CLOUDFLARE_REALTIME_APP_ID and CLOUDFLARE_REALTIME_APP_SECRET are set.

import { describe, expect, test } from "bun:test";

import {
  CloudflareRealtimeAPI,
  CloudflareRealtimeCall,
  CloudflareRealtimeError,
  type FetchFn,
} from "../src/api.ts";

interface Recorded {
  method: string;
  url: string;
  auth: string | null;
  body: any;
}

type Route = (req: Recorded) => { status?: number; body: unknown };

/** A fake API: answers each request with the first matching route. */
function fakeApi(routes: [RegExp, string, Route][]) {
  const requests: Recorded[] = [];
  const fetch: FetchFn = async (input, init) => {
    const req: Recorded = {
      method: init.method ?? "GET",
      url: input,
      auth: new Headers(init.headers).get("authorization"),
      body: init.body ? JSON.parse(init.body as string) : null,
    };
    requests.push(req);
    const path = new URL(input).pathname;
    for (const [pattern, method, route] of routes) {
      if (pattern.test(path) && method === req.method) {
        const { status = 200, body } = route(req);
        return new Response(JSON.stringify(body), { status });
      }
    }
    return new Response(JSON.stringify({ errorCode: "not_found" }), { status: 404 });
  };
  const api = new CloudflareRealtimeAPI({ appId: "app1", appSecret: "secret1", fetch });
  return { api, requests };
}

const OFFER = { type: "offer" as const, sdp: "v=0 offer" };
const ANSWER = { type: "answer" as const, sdp: "v=0 answer" };
const ENDPOINTS = { input: "wss://bot.example/in?t=x", output: "wss://bot.example/out?t=x" };

function happyRoutes(): [RegExp, string, Route][] {
  return [
    [/\/sessions\/new$/, "POST", () => ({ status: 201, body: { sessionId: "user-session" } })],
    [
      /\/sessions\/user-session\/tracks\/new$/,
      "POST",
      (req) =>
        req.body.sessionDescription
          ? {
              body: {
                sessionDescription: { type: "answer", sdp: "sfu answer" },
                tracks: [{ mid: "0", trackName: req.body.tracks[0].trackName }],
              },
            }
          : {
              body: {
                requiresImmediateRenegotiation: true,
                sessionDescription: { type: "offer", sdp: "sfu offer" },
                tracks: [
                  { mid: "1", sessionId: "bot-session", trackName: req.body.tracks[0].trackName },
                ],
              },
            },
    ],
    [
      /\/adapters\/websocket\/new$/,
      "POST",
      (req) => ({
        body: {
          tracks: req.body.tracks.map((t: any, i: number) =>
            t.location === "local"
              ? {
                  trackName: t.trackName,
                  adapterId: `a${i}`,
                  sessionId: "bot-session",
                  endpoint: t.endpoint,
                }
              : { trackName: t.trackName, adapterId: `a${i}`, endpoint: t.endpoint },
          ),
        },
      }),
    ],
    [/\/sessions\/user-session\/renegotiate$/, "PUT", () => ({ body: {} })],
    [
      /\/adapters\/websocket\/close$/,
      "POST",
      (req) => ({
        body: { tracks: req.body.tracks.map((t: any) => ({ adapterId: t.adapterId })) },
      }),
    ],
    [
      /\/sessions\/user-session\/tracks\/close$/,
      "PUT",
      (req) => ({ body: { tracks: req.body.tracks.map((t: any) => ({ mid: t.mid })) } }),
    ],
  ];
}

describe("CloudflareRealtimeCall", () => {
  test("publishes the user, attaches the bot, subscribes the user and closes", async () => {
    const { api, requests } = fakeApi(happyRoutes());
    const call = new CloudflareRealtimeCall(api, { userTrackName: "mic", botTrackName: "bot" });

    const published = await call.publishUser(OFFER, "0");
    expect(published).toEqual({
      sessionId: "user-session",
      sessionDescription: { type: "answer", sdp: "sfu answer" },
    });

    const bot = await call.attachBot(ENDPOINTS);
    expect(bot).toEqual({ sessionId: "bot-session", trackName: "bot" });

    const subscribed = await call.subscribeUser();
    expect(subscribed).toEqual({
      sessionDescription: { type: "offer", sdp: "sfu offer" },
      requiresImmediateRenegotiation: true,
    });

    await call.renegotiate(ANSWER);
    expect(call.state).toEqual({
      userSessionId: "user-session",
      userMids: ["0", "1"],
      userTrackName: "mic",
      botSessionId: "bot-session",
      botTrackName: "bot",
      adapterIds: ["a0", "a1"],
    });

    expect(await call.close()).toBe(true);
    expect(call.state.adapterIds).toEqual([]);
    expect(call.state.userMids).toEqual([]);

    for (const r of requests) {
      expect(r.url.startsWith("https://rtc.live.cloudflare.com/v1/apps/app1/")).toBe(true);
      expect(r.auth).toBe("Bearer secret1");
    }
    expect(
      requests.map((r) => `${r.method} ${new URL(r.url).pathname.replace("/v1/apps/app1", "")}`),
    ).toEqual([
      "POST /sessions/new",
      "POST /sessions/user-session/tracks/new",
      "POST /adapters/websocket/new",
      "POST /sessions/user-session/tracks/new",
      "PUT /sessions/user-session/renegotiate",
      "POST /adapters/websocket/close",
      "PUT /sessions/user-session/tracks/close",
    ]);
    expect(requests[1]!.body).toEqual({
      sessionDescription: OFFER,
      tracks: [{ location: "local", mid: "0", trackName: "mic" }],
    });
    expect(requests[2]!.body).toEqual({
      tracks: [
        { location: "local", trackName: "bot", endpoint: ENDPOINTS.output, inputCodec: "pcm" },
        {
          location: "remote",
          sessionId: "user-session",
          trackName: "mic",
          endpoint: ENDPOINTS.input,
          outputCodec: "pcm",
        },
      ],
    });
    expect(requests[3]!.body).toEqual({
      tracks: [{ location: "remote", sessionId: "bot-session", trackName: "bot" }],
    });
    expect(requests[4]!.body).toEqual({ sessionDescription: ANSWER });
    expect(requests[5]!.body).toEqual({ tracks: [{ adapterId: "a0" }, { adapterId: "a1" }] });
    expect(requests[6]!.body).toEqual({ tracks: [{ mid: "0" }, { mid: "1" }], force: true });
  });

  test("connectBot attaches and subscribes", async () => {
    const { api } = fakeApi(happyRoutes());
    const call = new CloudflareRealtimeCall(api);
    await call.publishUser(OFFER, "0");
    const offer = await call.connectBot(ENDPOINTS);
    expect(offer.sessionDescription.type).toBe("offer");
    expect(call.state.botSessionId).toBe("bot-session");
  });

  test("keeps adapters a partly failed batch allocated, and throws", async () => {
    const routes = happyRoutes();
    routes.unshift([
      /\/adapters\/websocket\/new$/,
      "POST",
      (req) => ({
        body: {
          tracks: [
            { trackName: req.body.tracks[0].trackName, adapterId: "a0", sessionId: "bot-session" },
            {
              trackName: req.body.tracks[1].trackName,
              errorCode: "websocket_handshake_failed",
              errorDescription: "The handshake with the provided endpoint failed.",
            },
          ],
        },
      }),
    ]);
    const { api } = fakeApi(routes);
    const call = new CloudflareRealtimeCall(api);
    await call.publishUser(OFFER, "0");
    const error = await call.attachBot(ENDPOINTS).catch((e) => e);
    expect(error).toBeInstanceOf(CloudflareRealtimeError);
    expect(String(error.message)).toContain("websocket_handshake_failed");
    expect(call.state.adapterIds).toEqual(["a0"]);
  });

  test("returns the item results of a 503 batch where every item failed", async () => {
    const { api } = fakeApi([
      [
        /\/adapters\/websocket\/new$/,
        "POST",
        () => ({
          status: 503,
          body: { tracks: [{ trackName: "t", errorCode: "websocket_handshake_failed" }] },
        }),
      ],
    ]);
    const result = await api.createWebSocketAdapters([
      { location: "local", trackName: "t", endpoint: "wss://x.example", inputCodec: "pcm" },
    ]);
    expect(result.tracks?.[0]?.errorCode).toBe("websocket_handshake_failed");
  });

  test("throws CloudflareRealtimeError on HTTP errors", async () => {
    const { api } = fakeApi([
      [
        /\/sessions\/new$/,
        "POST",
        () => ({ status: 401, body: { errorCode: "unauthorized", errorDescription: "bad token" } }),
      ],
    ]);
    const error = await api.createSession().catch((e) => e);
    expect(error).toBeInstanceOf(CloudflareRealtimeError);
    expect(error.status).toBe(401);
    expect(error.errorCode).toBe("unauthorized");
    expect(String(error.message)).not.toContain("secret1");
  });

  test("a failed close keeps what is left in the state, for a retry", async () => {
    const routes = happyRoutes();
    routes.unshift([
      /\/adapters\/websocket\/close$/,
      "POST",
      () => ({
        body: { tracks: [{ adapterId: "a0" }, { adapterId: "a1", errorCode: "internal" }] },
      }),
    ]);
    routes.unshift([
      /\/sessions\/user-session\/tracks\/close$/,
      "PUT",
      () => ({ status: 410, body: { errorCode: "session_error" } }),
    ]);
    const { api } = fakeApi(routes);
    const call = new CloudflareRealtimeCall(api);
    await call.publishUser(OFFER, "0");
    await call.attachBot(ENDPOINTS);
    expect(await call.close()).toBe(false);
    expect(call.state.adapterIds).toEqual(["a1"]);
    // 410: the session is gone, so its tracks are too.
    expect(call.state.userMids).toEqual([]);

    // A new call resumes from the saved state.
    const resumed = new CloudflareRealtimeCall(fakeApi(happyRoutes()).api, { state: call.state });
    expect(await resumed.close()).toBe(true);
  });

  test("checks its inputs and order", async () => {
    const { api } = fakeApi(happyRoutes());
    const call = new CloudflareRealtimeCall(api);
    await expect(call.attachBot(ENDPOINTS)).rejects.toThrow("publishUser");
    await expect(call.subscribeUser()).rejects.toThrow("attachBot");
    await expect(call.publishUser(ANSWER as never, "0")).rejects.toThrow("offer");
    expect(() => new CloudflareRealtimeAPI({ appId: "", appSecret: "x" })).toThrow();
  });
});

const APP_ID = process.env.CLOUDFLARE_REALTIME_APP_ID;
const APP_SECRET = process.env.CLOUDFLARE_REALTIME_APP_SECRET;

describe.skipIf(!APP_ID || !APP_SECRET)("live Cloudflare Realtime API", () => {
  test("creates a session, reads it, and reports an unreachable adapter endpoint", async () => {
    const api = new CloudflareRealtimeAPI({ appId: APP_ID!, appSecret: APP_SECRET! });
    const session = await api.createSession({ correlationId: "pipedog-live-test" });
    expect(session.sessionId).toMatch(/\S+/);
    const info = await api.getSession(session.sessionId);
    expect(info).toBeTruthy();

    // No public endpoint here: the SFU's handshake must fail, as an item error.
    const result = await api.createWebSocketAdapters([
      {
        location: "local",
        trackName: "pipedog-live-test",
        endpoint: "wss://pipedog-live-test.invalid/output",
        inputCodec: "pcm",
      },
    ]);
    const item = result.tracks?.[0];
    expect(item?.errorCode ?? null).not.toBeNull();
    if (item?.adapterId) await api.closeWebSocketAdapters([item.adapterId]);
  }, 30_000);
});
