// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The demo end to end: `wrangler dev` runs the Worker and both Durable Objects locally (workerd),
// with Workers AI, Claude, Open-Meteo, the docs index and Turnstile faked on one local server
// (test/fakes.ts). A scripted browser gets a ticket the way the page does, opens the session's
// WebSocket, and the test checks the RTVI messages the page gets: the transcript, the tool call
// and its result, the bot's text, the metrics, the latency and the data centres.
//
// The same session over WebRTC, against a fake Cloudflare Realtime SFU that dials the bot's media
// endpoints like the real one (no real WebRTC: the SDP is opaque to it). Then the security checks:
// tickets that are missing, forged, for another session or used twice, call and adapter tokens,
// origins that aren't allowed, the per-IP rate limit, WebRTC switched off, and the kill switch.
// (test/browser.test.ts drives the real page in Chromium.)

import { afterAll, beforeAll, expect, test } from "bun:test";
import { websocketConnect } from "@pipedog/transport-websocket/socket";
import { type FakeSfu, startFakeSfu } from "../../workers-realtime-voice-agent/test/fake_sfu.ts";
import { type Fakes, fakeVars, startFakes } from "./fakes.ts";
import { connectBrowser, type RtviMessage } from "./rtvi_client.ts";
import {
  printProblems,
  STARTUP_TIMEOUT,
  startWranglerDev,
  type WranglerDev,
} from "./wrangler_dev.ts";

const ORIGIN = "http://localhost:3000";

let fakes: Fakes;
let sfu: FakeSfu;
let worker: WranglerDev | null = null;
let base = "";

async function getTicket(
  token = "pass-token",
  origin = ORIGIN,
  transport = "websocket",
  at = base,
): Promise<Response> {
  return await fetch(`${at}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ turnstileToken: token, transport }),
  });
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Try to open a session socket; resolve with the HTTP status of a refused upgrade, or 101. */
async function upgradeStatus(url: string, origin = ORIGIN): Promise<number> {
  const response = await fetch(url.replace(/^ws/, "http"), {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      origin,
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });
  await response.body?.cancel();
  return response.status;
}

beforeAll(async () => {
  fakes = startFakes({
    turns: ["What's the weather in Paris?", "Tell me something dangerous.", "Thanks, bye!"],
    turnEvery: 120,
  });
  sfu = startFakeSfu();
  worker = await startWranglerDev({
    vars: [
      "ANTHROPIC_API_KEY:test-anthropic-key",
      "SESSION_SIGNING_KEY:test-signing-key",
      "TURNSTILE_SECRET_KEY:turnstile-secret",
      "CLOUDFLARE_REALTIME_APP_ID:test-app",
      "CLOUDFLARE_REALTIME_APP_SECRET:test-secret",
      `CLOUDFLARE_REALTIME_API_URL:${sfu.baseUrl}`,
      "DEMO_DEV_MODE:true",
      ...fakeVars(fakes.url),
    ],
  });
  base = worker.base;
}, STARTUP_TIMEOUT);

afterAll(async () => {
  if (worker) await printProblems(worker.logFile);
  worker?.stop();
  fakes?.stop();
  sfu?.stop();
});

let sessionWsUrl = "";

test("the page is served, and only the docs may frame it", async () => {
  const page = await fetch(`${base}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Talk to pipedog");
  expect(page.headers.get("content-security-policy")).toBe(
    "frame-ancestors 'self' http://localhost:3000",
  );
  expect(page.headers.get("permissions-policy")).toContain("microphone=(self)");
});

test("the status endpoint answers allowed origins with CORS", async () => {
  const ok = await fetch(`${base}/api/status`, { headers: { origin: ORIGIN } });
  expect(await ok.json()).toMatchObject({
    enabled: true,
    transports: { websocket: true, webrtc: true },
    turnstileSiteKey: null,
    turnstileRequired: true,
  });
  expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);

  const other = await fetch(`${base}/api/status`, { headers: { origin: "https://evil.test" } });
  expect(other.headers.get("access-control-allow-origin")).toBeNull();

  const preflight = await fetch(`${base}/api/session`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.test", "access-control-request-method": "POST" },
  });
  expect(preflight.status).toBe(403);
});

test("a ticket needs an allowed origin and a Turnstile token that verifies", async () => {
  const wrongOrigin = await getTicket("pass-token", "https://evil.test");
  expect(wrongOrigin.status).toBe(403);
  expect((await wrongOrigin.json()).error).toBe("origin");

  // Turnstile is checked (the secret is set), so a bad token is refused, dev mode or not.
  const badToken = await getTicket("not-a-human");
  expect(badToken.status).toBe(403);
  expect((await badToken.json()).error).toBe("turnstile");
  expect(fakes.siteverify.at(-1)?.secret).toBe("turnstile-secret");
});

test("a session: transcript, tool call, reply, metrics, latency and data centres reach the page", async () => {
  const response = await getTicket();
  expect(response.status).toBe(200);
  const { sessionId, wsUrl, expiresIn } = (await response.json()) as Record<string, any>;
  expect(expiresIn).toBe(60);
  expect(wsUrl).toContain(`/api/session/${sessionId}/ws?ticket=`);
  sessionWsUrl = wsUrl;

  const browser = await connectBrowser(wsUrl, ORIGIN);
  try {
    const isServer = (type: string) => (m: RtviMessage) =>
      m.type === "server-message" && m.data?.type === type;

    // Ready, and told about the session: the Durable Object's colo (from the faked trace) and
    // where the visitor came in (miniflare's request.cf).
    await browser.waitFor((m) => m.type === "bot-ready");
    const info = await browser.waitFor(isServer("session-info"));
    expect(info.data.transport).toBe("websocket");
    expect(info.data.bot_colo).toBe("MAD");
    expect(info.data.limits).toEqual({ max_secs: 120, idle_secs: 30, max_turns: 12 });
    expect(Object.keys(info.data.visitor).sort()).toEqual(["city", "colo", "country"]);

    // The ping the page times.
    const pong = await browser.request("ping", { t: 1 });
    expect(pong.data.d.pong).toBe(true);

    // The user's turn, interim then final.
    const final = await browser.waitFor(
      (m) => m.type === "user-transcription" && m.data?.final === true,
      45_000,
    );
    expect(final.data.text).toBe("What's the weather in Paris?");
    expect(
      browser.messages.some((m) => m.type === "user-transcription" && m.data?.final === false),
    ).toBe(true);

    // The tool call, with its arguments and result.
    const inProgress = await browser.waitFor((m) => m.type === "llm-function-call-in-progress");
    expect(inProgress.data.function_name).toBe("get_weather");
    expect(inProgress.data.arguments).toEqual({ city: "Paris" });
    const stopped = await browser.waitFor((m) => m.type === "llm-function-call-stopped");
    expect(stopped.data.tool_call_id).toBe(inProgress.data.tool_call_id);
    expect(stopped.data.result.temperature_c).toBe(18.4);
    expect(stopped.data.result.place).toBe("Paris, Île-de-France, France");

    // The bot's answer, as streamed text, and spoken.
    await browser.waitFor(
      (m) => m.type === "bot-llm-text" && String(m.data?.text).includes("degrees"),
      20_000,
    );
    await until(() => fakes.spoken.join(" ").includes("18 degrees"), 10_000, "the answer spoken");
    expect(browser.audioBytes()).toBeGreaterThan(0);

    // TTFB metrics for the services, and the voice-to-voice latency of the reply.
    await browser.waitFor((m) => m.type === "metrics" && Array.isArray(m.data?.ttfb), 20_000);
    const ttfb = browser.messages
      .filter((m) => m.type === "metrics")
      .flatMap((m) => (m.data.ttfb ?? []) as { processor: string }[])
      .map((t) => t.processor);
    expect(ttfb.some((p) => p.includes("Anthropic"))).toBe(true);
    expect(ttfb.some((p) => p.includes("Aura"))).toBe(true);
    const latency = await browser.waitFor(isServer("voice-latency"), 20_000);
    expect(latency.data.seconds).toBeGreaterThan(0);
    expect(latency.data.seconds).toBeLessThan(20);

    // Claude declines the second request (stop_reason "refusal"): the bot says so, and the page
    // is told what it said.
    const refusal = await browser.waitFor(
      (m) => isServer("bot-speech")(m) && m.data.kind === "refusal",
      30_000,
    );
    expect(refusal.data.text).toContain("can't help with that");

    // "Thanks, bye!": Claude calls end_call, the bot says goodbye and the session ends.
    const ending = await browser.waitFor(isServer("session-ending"), 30_000);
    expect(ending.data.reason).toBe("goodbye");
    await Promise.race([
      browser.closed,
      Bun.sleep(20_000).then(() => {
        throw new Error("the session didn't end");
      }),
    ]);
    expect(fakes.spoken.join(" ")).toContain("Thanks for trying pipedog. Bye!");
  } finally {
    await browser.close();
  }

  // What Claude was sent: the right model, low effort, no sampling parameters, a modest
  // max_tokens, the stable prefix cached, and the tools.
  expect(fakes.anthropicRequests.length).toBeGreaterThanOrEqual(2);
  for (const body of fakes.anthropicRequests) {
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(400);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(body).not.toHaveProperty("thinking");
    expect(body.tool_choice ?? { type: "auto" }).toEqual({ type: "auto" });
    expect(body.system.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "end_call",
      "get_time",
      "get_weather",
      "search_docs",
      "where_am_i",
    ]);
    // No prefill: the conversation sent always ends with the user.
    expect(body.messages.at(-1).role).toBe("user");
  }
  expect(fakes.anthropicHeaders[0]?.["x-api-key"]).toBe("test-anthropic-key");
}, 120_000);

test("the same session over WebRTC, through a fake Cloudflare Realtime SFU", async () => {
  const response = await getTicket("pass-token", ORIGIN, "webrtc");
  expect(response.status).toBe(200);
  const { sessionId, rtcUrl, ticket } = (await response.json()) as Record<string, string>;
  expect(rtcUrl).toBe(`${base}/api/session/${sessionId}/rtc`);
  const post = (action: string, body: unknown, headers: Record<string, string> = {}, query = "") =>
    fetch(`${rtcUrl}/${action}${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    });
  const withTicket = `?ticket=${encodeURIComponent(ticket!)}`;

  // 1. The browser publishes its microphone, with the ticket; it gets the call token.
  const offer = { sessionDescription: { type: "offer", sdp: "browser offer" }, mid: "0" };
  expect((await post("offer", offer)).status).toBe(401);
  const published = await post("offer", offer, {}, withTicket);
  expect(published.status).toBe(200);
  const { sessionDescription, callToken } = (await published.json()) as Record<string, any>;
  expect(sessionDescription).toEqual({ type: "answer", sdp: "fake answer" });
  expect(callToken).toMatch(/^[0-9a-f]{64}$/);
  // The ticket was single use.
  expect((await post("offer", offer, {}, withTicket)).status).toBe(409);

  // 2. The messages socket, with the call token.
  const messages: RtviMessage[] = [];
  const wsBase = rtcUrl!.replace(/^http/, "ws");
  expect(await upgradeStatus(`${wsBase}/messages?token=nope`)).toBe(403);
  const ws = new WebSocket(`${wsBase}/messages?token=${callToken}`, {
    headers: { Origin: ORIGIN },
  } as unknown as string[]);
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  // 3. The SFU attaches the bot, dialing the media endpoints with the adapter token.
  expect((await post("connect", {})).status).toBe(403);
  const connected = await post("connect", {}, { "x-demo-call-token": callToken });
  expect(connected.status).toBe(200);
  expect(((await connected.json()) as any).sessionDescription).toEqual({
    type: "offer",
    sdp: "fake offer",
  });
  expect(sfu.open("local") && sfu.open("remote")).toBe(true);
  const adapters = sfu.requests.find((r) => r.path === "/adapters/websocket/new")!;
  expect(adapters.auth).toBe("Bearer test-secret");
  const endpoint = String(adapters.body.tracks[0].endpoint);
  expect(endpoint).toMatch(
    new RegExp(`/api/session/${sessionId}/rtc/media/output\\?token=[0-9a-f]{64}$`),
  );
  // The adapter token isn't the call token, and the call token doesn't open the media sockets.
  expect(endpoint).not.toContain(callToken);
  expect(await upgradeStatus(`${wsBase}/media/input?token=${callToken}`)).toBe(403);
  const answered = await post(
    "answer",
    { sessionDescription: { type: "answer", sdp: "browser answer" } },
    { "x-demo-call-token": callToken },
  );
  expect(answered.status).toBe(200);

  // 4. RTVI: client-ready; then the same conversation as over the WebSocket.
  ws.send(
    JSON.stringify({ label: "rtvi-ai", type: "client-ready", id: "1", data: { version: "1.0.0" } }),
  );
  await until(() => messages.some((m) => m.type === "bot-ready"), 15_000, "bot-ready");
  await until(() => sfu.botSpeechBytes() > 0, 20_000, "the greeting on the bot's track");
  // The microphone: silence, which the fake Flux turns into the scripted turns.
  const speaking = sfu.speak(new Uint8Array(48000 * 4 * 8));
  await until(
    () => messages.some((m) => m.type === "llm-function-call-stopped"),
    30_000,
    "the tool call",
  );
  await until(
    () => messages.some((m) => m.type === "server-message" && m.data?.type === "voice-latency"),
    30_000,
    "the voice-to-voice latency",
  );
  const info = messages.find((m) => m.type === "server-message" && m.data?.type === "session-info");
  expect(info?.data.transport).toBe("webrtc");
  expect(info?.data.bot_colo).toBe("MAD");
  expect(messages.some((m) => m.type === "user-transcription" && m.data?.final)).toBe(true);
  expect(messages.some((m) => m.type === "metrics")).toBe(true);

  // 5. Hang up: the session's Realtime resources are released.
  ws.close();
  await speaking.catch(() => {});
  await until(
    () =>
      sfu.requests.some((r) => r.path === "/adapters/websocket/close") &&
      sfu.requests.some((r) => /tracks\/close$/.test(r.path)),
    15_000,
    "the Realtime cleanup",
  );
  expect(sfu.open("local") || sfu.open("remote")).toBe(false);
  // The call token died with the session.
  expect((await post("connect", {}, { "x-demo-call-token": callToken })).status).toBe(403);
}, 120_000);

test("a ticket works once", async () => {
  expect(sessionWsUrl).not.toBe("");
  expect(await upgradeStatus(sessionWsUrl)).toBe(409);
});

test("the WebSocket needs a valid ticket for its session, from an allowed origin", async () => {
  const sessionId = "AAAAAAAAAAAAAAAAAAAAAA";
  const ws = (q: string) => `${base.replace("http", "ws")}/api/session/${sessionId}/ws${q}`;
  // No ticket, a garbled one, a forged signature.
  expect(await upgradeStatus(ws(""))).toBe(401);
  expect(await upgradeStatus(ws("?ticket=nonsense"))).toBe(401);
  const used = new URL(sessionWsUrl).searchParams.get("ticket")!;
  const [body] = used.split(".");
  expect(await upgradeStatus(ws(`?ticket=${body}.${"A".repeat(43)}`))).toBe(401);
  // A real ticket, presented for another session.
  expect(await upgradeStatus(ws(`?ticket=${used}`))).toBe(401);
  // From a page that isn't allowed (checked before the ticket).
  expect(await upgradeStatus(ws(`?ticket=${used}`), "https://evil.test")).toBe(403);
  // And the socket refuses to open from a client too.
  await expect(
    websocketConnect(ws(""), { additionalHeaders: { Origin: ORIGIN } }),
  ).rejects.toThrow();
});

test("tickets are rate limited per IP", async () => {
  // Three tickets a minute per IP. (The earlier tests took some; the window may have rolled.)
  let refused = await getTicket();
  for (let i = 0; i < 3 && refused.status === 200; i++) refused = await getTicket();
  expect(refused.status).toBe(429);
  expect((await refused.json()).message).toContain("few minutes");
});

test(
  "without Realtime credentials, WebRTC is reported unavailable and refused",
  async () => {
    const noRtc = await startWranglerDev({
      vars: ["SESSION_SIGNING_KEY:test-signing-key", "DEMO_DEV_MODE:true"],
      logName: "wrangler-no-rtc.log",
    });
    try {
      const status = await (await fetch(`${noRtc.base}/api/status`)).json();
      expect(status).toMatchObject({
        enabled: true,
        transports: { websocket: true, webrtc: false },
        // Dev mode without a Turnstile secret: the local bypass.
        turnstileRequired: false,
      });
      const refused = await getTicket("", ORIGIN, "webrtc", noRtc.base);
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toBe("webrtc_unavailable");
      expect((await getTicket("", ORIGIN, "websocket", noRtc.base)).status).toBe(200);
    } finally {
      noRtc.stop();
    }
  },
  STARTUP_TIMEOUT,
);

test(
  "the kill switch refuses everything",
  async () => {
    const off = await startWranglerDev({
      vars: ["SESSION_SIGNING_KEY:test-signing-key", "DEMO_ENABLED:false", "DEMO_DEV_MODE:true"],
      logName: "wrangler-off.log",
    });
    try {
      const status = await fetch(`${off.base}/api/status`, { headers: { origin: ORIGIN } });
      expect(await status.json()).toMatchObject({ enabled: false });
      const ticket = await getTicket("", ORIGIN, "websocket", off.base);
      expect(ticket.status).toBe(503);
      expect((await ticket.json()).error).toBe("disabled");
      const ws = await upgradeStatus(
        `${off.base.replace("http", "ws")}/api/session/AAAAAAAAAAAAAAAAAAAAAA/ws?ticket=x`,
      );
      expect(ws).toBe(503);
    } finally {
      off.stop();
    }
  },
  STARTUP_TIMEOUT,
);
