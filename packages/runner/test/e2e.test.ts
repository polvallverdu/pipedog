// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The development runner end to end, with the bot in test/e2e/bot.ts (a migrated
// bot.py: createTransport over WebRTC or Telnyx, greeting through OpenAI speech,
// which test-mocks' OpenAI mock stands in for):
//
// - `-t webrtc`: headless Chromium opens `/`, lands on the prebuilt client at
//   `/client/`, presses Connect, and receives the bot's greeting as audio over
//   SmallWebRTC (`/start`, then `/sessions/{id}/api/offer`).
// - `-t telnyx`: the TeXML webhook, then a scripted fake Telnyx (`connected`,
//   `start`, media) through the handshake: the bot gets the stream ID and call
//   control ID, and its greeting comes back as Telnyx `media` events. Callers who
//   hang up before `start` are reported as a typed outcome.
// - `bun bot.ts -t telnyx` in a child process: `main()` finds `bot` on the entry
//   script, and the routes the bot added to the module-level `app` are served.
//
// The browser test needs a Chromium for playwright-core (`bunx playwright install
// chromium`, or PIPEDOG_E2E_CHROMIUM=<path>); it is skipped when none is found.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { type MockOpenAI, startMockOpenAI } from "../../../examples/test-mocks/src/mock_openai.ts";

import { main, RunnerApp } from "../src/run.ts";
import type { RunnerServer } from "../src/serve.ts";
import { bot, GREETING_TEXT, type Outcome, outcomes } from "./e2e/bot.ts";

async function findChromium(): Promise<string | null> {
  if (process.env.PIPEDOG_E2E === "0") return null;
  const explicit = process.env.PIPEDOG_E2E_CHROMIUM;
  if (explicit) return existsSync(explicit) ? explicit : null;
  try {
    const { chromium } = await import("playwright-core");
    const path = chromium.executablePath();
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

const chromiumPath = await findChromium();

let openai: MockOpenAI;
const savedEnv = { ...process.env };

beforeAll(() => {
  openai = startMockOpenAI();
  process.env.OPENAI_BASE_URL = openai.baseUrl;
  process.env.TELNYX_API_KEY = "test-telnyx-key";
});

afterAll(() => {
  openai.stop();
  for (const key of ["OPENAI_BASE_URL", "TELNYX_API_KEY"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function eventually<T>(
  read: () => T | null | undefined | false,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startRunner(argv: string[]): Promise<RunnerServer> {
  const server = await main({
    argv: [...argv, "--host", "127.0.0.1", "--port", "0"],
    bot,
    app: new RunnerApp(),
    handleSignals: false,
  });
  if (!server) throw new Error("the runner did not start");
  return server;
}

/** Records every RTCPeerConnection's remote audio level as `window.__maxRms`. */
function captureRemoteAudio(): void {
  const audio = new AudioContext();
  (window as any).__audio = audio;
  (window as any).__maxRms = 0;
  const samples = new Float32Array(2048);
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      this.addEventListener("track", (event: RTCTrackEvent) => {
        if (event.track.kind !== "audio") return;
        const analyser = audio.createAnalyser();
        analyser.fftSize = samples.length;
        audio.createMediaStreamSource(new MediaStream([event.track])).connect(analyser);
        setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const v of samples) sum += v * v;
          const rms = Math.sqrt(sum / samples.length);
          (window as any).__maxRms = Math.max((window as any).__maxRms, rms);
        }, 50);
      });
    }
  } as typeof RTCPeerConnection;
}

describe.skipIf(!chromiumPath)("-t webrtc: the prebuilt client in a real browser", () => {
  test("/ redirects to the prebuilt client, which connects and plays the bot's greeting", async () => {
    const { chromium } = await import("playwright-core");
    const server = await startRunner(["-t", "webrtc"]);
    const browser: Browser = await chromium.launch({
      executablePath: chromiumPath!,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const before = outcomes.length;
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(captureRemoteAudio);
      await page.goto(`${server.url}/`);
      expect(new URL(page.url()).pathname).toBe("/client/");

      // Ready once the client has initialized its devices.
      const connect = page.locator('[data-slot="connect-button"][data-state="initialized"]');
      await connect.waitFor();
      await connect.click();
      await page.evaluate(() => (window as any).__audio.resume());

      // The bot started over SmallWebRTC and greeted the user...
      await eventually(() => outcomes.slice(before).some((o) => o.kind === "webrtc"));
      await eventually(() => openai.spoken.includes(GREETING_TEXT), 30_000);
      // ...and the browser heard it.
      let loudest = 0;
      for (let i = 0; i < 200 && loudest <= 0.01; i++) {
        loudest = await page.evaluate(() => (window as any).__maxRms as number);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(loudest).toBeGreaterThan(0.01);
      expect(
        await page.locator('[data-slot="connect-button"]').getAttribute("data-state"),
      ).not.toBe("initialized");
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  }, 90_000);
});

/** Telnyx's handshake messages for a call. */
function telnyxMessages(callControlId: string, streamId: string) {
  return {
    connected: { event: "connected", version: "1.0.0" },
    start: {
      event: "start",
      sequence_number: "1",
      start: {
        user_id: "u-1",
        call_control_id: callControlId,
        call_session_id: "sess-1",
        from: "+15551234567",
        to: "+15559876543",
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      },
      stream_id: streamId,
    },
  };
}

/** A fake Telnyx media stream client. */
async function openStream(server: RunnerServer): Promise<{
  ws: WebSocket;
  received: Record<string, any>[];
  closed: Promise<number>;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const received: Record<string, any>[] = [];
  ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (event) => resolve(event.code)),
  );
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  return { ws, received, closed };
}

describe("-t telnyx: a scripted Telnyx call", () => {
  let server: RunnerServer;

  beforeAll(async () => {
    server = await startRunner(["-t", "telnyx", "--proxy", "https://mybot.ngrok.io/"]);
  });

  afterAll(async () => {
    await server?.close();
  });

  test("POST / answers with TeXML that streams the call to wss://<proxy>/ws", async () => {
    const response = await fetch(`${server.url}/`, { method: "POST" });
    expect(response.headers.get("content-type")).toBe("application/xml");
    expect(await response.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Connect>\n' +
        '    <Stream url="wss://mybot.ngrok.io/ws" bidirectionalMode="rtp"></Stream>\n' +
        "  </Connect>\n</Response>",
    );
  });

  test("/start returns the media WebSocket URL and other transports are refused", async () => {
    const ok = await fetch(`${server.url}/start`, { method: "POST", body: "{}" });
    expect(await ok.json()).toEqual({ wsUrl: "wss://127.0.0.1:0/ws" });
    const refused = await fetch(`${server.url}/start`, {
      method: "POST",
      body: JSON.stringify({ transport: "webrtc" }),
    });
    expect(refused.status).toBe(400);
  });

  test("connected, start: the bot gets the call's IDs and greets the caller in media events", async () => {
    const before = outcomes.length;
    const { ws, received, closed } = await openStream(server);
    const { connected, start } = telnyxMessages("v3:cc-123", "stream-abc");
    ws.send(JSON.stringify(connected));
    ws.send(JSON.stringify(start));

    const call = await eventually(() =>
      outcomes.slice(before).find((o: Outcome) => o.kind === "call"),
    );
    expect(call).toMatchObject({
      transportType: "telnyx",
      callId: "v3:cc-123",
      streamId: "stream-abc",
    });
    expect((call.handshake as { status: string }).status).toBe("started");

    // The greeting comes back as Telnyx media events: base64 μ-law at 8 kHz.
    await eventually(() => received.filter((m) => m.event === "media").length > 10, 30_000);
    const media = received.find((m) => m.event === "media")!;
    expect(Object.keys(media)).toEqual(["event", "media"]);
    expect(atob(media.media.payload).length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ event: "stop", stop: { call_control_id: "v3:cc-123" } }));
    ws.close(1000);
    await closed;
  }, 60_000);

  test("the caller hangs up after connected, before start: a typed outcome", async () => {
    const before = outcomes.length;
    const { ws, closed } = await openStream(server);
    ws.send(JSON.stringify(telnyxMessages("v3:cc-2", "s-2").connected));
    ws.close(1000);
    await closed;
    const hungUp = await eventually(() =>
      outcomes.slice(before).find((o: Outcome) => o.kind === "hung-up"),
    );
    expect(hungUp.handshake).toEqual({ status: "closed", messagesReceived: 1 });
    expect(hungUp.error).toBe("ValueError");
  });

  test("the caller hangs up before any message: a typed outcome", async () => {
    const before = outcomes.length;
    const { ws, closed } = await openStream(server);
    ws.close(1000);
    await closed;
    const hungUp = await eventually(() =>
      outcomes.slice(before).find((o: Outcome) => o.kind === "hung-up"),
    );
    expect(hungUp.handshake).toEqual({ status: "closed", messagesReceived: 0 });
  });
});

describe("bun bot.ts -t telnyx: a separate process", () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let port = 0;

  beforeAll(async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    port = probe.port as number;
    probe.stop(true);
    proc = Bun.spawn(
      [
        process.execPath,
        "bot.ts",
        "-t",
        "telnyx",
        "--proxy",
        "mybot.ngrok.io",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        cwd: join(import.meta.dir, "e2e"),
        env: { ...process.env, OPENAI_BASE_URL: openai.baseUrl, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let out = "";
    const deadline = Date.now() + 30_000;
    while (!out.includes("WebSocket:") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    expect(out).toContain("PIPEDOG DEVELOPMENT RUNNER");
    expect(out).toContain("Bot ready! (Telnyx)");
    // The banner prints before the server listens; wait until it answers.
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/status`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, 60_000);

  afterAll(() => {
    proc?.kill();
  });

  test("main() finds bot on the entry script and serves the routes it added to app", async () => {
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    expect(status).toEqual({ status: "ready", transports: ["telnyx"] });
    const texml = await (await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })).text();
    expect(texml).toContain('<Stream url="wss://mybot.ngrok.io/ws" bidirectionalMode="rtp">');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    ws.send(JSON.stringify(telnyxMessages("v3:cc-proc", "s-proc").connected));
    ws.close(1000);

    let remote: Outcome[] = [];
    for (let i = 0; i < 100 && !remote.some((o) => o.kind === "hung-up"); i++) {
      remote = await (await fetch(`http://127.0.0.1:${port}/test/outcomes`)).json();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(remote.find((o) => o.kind === "hung-up")?.handshake).toEqual({
      status: "closed",
      messagesReceived: 1,
    });
  }, 30_000);
});
