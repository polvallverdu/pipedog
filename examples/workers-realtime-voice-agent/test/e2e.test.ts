// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The example end to end, without Cloudflare: `wrangler dev` runs the Worker and its Durable
// Object locally (workerd), a fake Realtime SFU (fake_sfu.ts) takes the place of Cloudflare's,
// and the OpenAI mock from examples/test-mocks answers. The test plays the browser's signaling
// and RTVI; the fake SFU plays the WebRTC side, dialing the bot's media endpoints as the real
// adapters do. What it can't cover is real WebRTC and the real SFU: see the README.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type MockOpenAI, startMockOpenAI } from "@pipedog/example-test-mocks/mock_openai";
import { ANSWER } from "@pipedog/example-test-mocks/mock_provider";
import { type FakeSfu, startFakeSfu, wavTo48kStereo } from "./fake_sfu.ts";

const EXAMPLE = join(import.meta.dir, "..");
const QUESTION_WAV = join(
  import.meta.dir,
  "..",
  "..",
  "test-mocks",
  "assets",
  "capital_question.wav",
);
const WRANGLER = join(EXAMPLE, "node_modules", ".bin", "wrangler");
const STARTUP_TIMEOUT_MS = 180_000;
const LOG_DIR = join(EXAMPLE, "node_modules", ".cache", "workers-realtime-e2e");
mkdirSync(LOG_DIR, { recursive: true });

let mock: MockOpenAI;
let sfu: FakeSfu;
let worker: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  mock = startMockOpenAI();
  sfu = startFakeSfu();

  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  port = probe.port as number;
  probe.stop(true);

  worker = Bun.spawn(
    [
      WRANGLER,
      "dev",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--var",
      "OPENAI_API_KEY:test-key",
      "--var",
      `OPENAI_BASE_URL:${mock.baseUrl}`,
      "--var",
      `OPENAI_REALTIME_URL:${mock.realtimeUrl}`,
      "--var",
      "CLOUDFLARE_REALTIME_APP_ID:test-app",
      "--var",
      "CLOUDFLARE_REALTIME_APP_SECRET:test-secret",
      "--var",
      `CLOUDFLARE_REALTIME_API_URL:${sfu.baseUrl}`,
      "--persist-to",
      mkdtempSync(join(LOG_DIR, "state-")),
    ],
    { cwd: EXAMPLE, stdout: "pipe", stderr: "pipe" },
  );
  rmSync(join(LOG_DIR, "wrangler.log"), { force: true });
  const log = Bun.file(join(LOG_DIR, "wrangler.log")).writer();
  const proc = worker;
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      const scan = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          log.write(chunk);
          if (decoder.decode(chunk).includes("Ready on")) resolve();
        }
      };
      scan(proc.stdout as ReadableStream<Uint8Array>).catch(reject);
      scan(proc.stderr as ReadableStream<Uint8Array>).catch(reject);
      proc.exited.then((code) => reject(new Error(`wrangler exited with code ${code}`)));
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("wrangler dev did not start")), STARTUP_TIMEOUT_MS),
    ),
  ]);
  // The first request compiles the Worker.
  await fetch(`http://127.0.0.1:${port}/`);
}, STARTUP_TIMEOUT_MS + 30_000);

afterAll(async () => {
  const log = Bun.file(join(LOG_DIR, "wrangler.log"));
  if (await log.exists()) {
    const problems = (await log.text())
      .split("\n")
      .filter((l) => /\b(ERROR|WARNING|Error)\b/.test(l));
    if (problems.length)
      console.log(`Worker warnings and errors:\n${problems.slice(-40).join("\n")}`);
  }
  worker?.kill();
  mock?.stop();
  sfu?.stop();
});

async function post(call: string, action: string, body: unknown = {}): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}/api/call/${call}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${action}: HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

test("serves the page", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("RTCPeerConnection");
});

test("a call: signaling, the SFU's adapters, RTVI, a spoken question and the bot's answer", async () => {
  const call = "alice";

  // 1. The browser publishes its microphone.
  const published = await post(call, "offer", {
    sessionDescription: { type: "offer", sdp: "browser offer" },
    mid: "0",
  });
  expect(published.sessionDescription).toEqual({ type: "answer", sdp: "fake answer" });

  // 2. The messages socket.
  const messages: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/call/${call}/messages`);
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  // 3. The SFU attaches the bot: it dials both media endpoints during this request.
  const subscription = await post(call, "connect");
  expect(subscription.sessionDescription).toEqual({ type: "offer", sdp: "fake offer" });
  expect(sfu.open("local") && sfu.open("remote")).toBe(true);
  await post(call, "answer", { sessionDescription: { type: "answer", sdp: "browser answer" } });

  const adapterRequest = sfu.requests.find((r) => r.path === "/adapters/websocket/new")!;
  expect(adapterRequest.auth).toBe("Bearer test-secret");
  const [output, input] = adapterRequest.body.tracks;
  expect(output.location).toBe("local");
  expect(output.inputCodec).toBe("pcm");
  expect(output.endpoint).toMatch(
    /^ws:\/\/127\.0\.0\.1:\d+\/api\/call\/alice\/media\/output\?token=\w+$/,
  );
  expect(input).toMatchObject({ location: "remote", sessionId: "session-1", outputCodec: "pcm" });

  // The adapter endpoints need the call's token.
  const forbidden = await fetch(
    `http://127.0.0.1:${port}/api/call/${call}/media/input?token=nope`,
    {
      headers: { Upgrade: "websocket" },
    },
  );
  expect(forbidden.status).toBe(403);

  // 4. RTVI: client-ready, and the bot greets.
  ws.send(
    JSON.stringify({
      label: "rtvi-ai",
      type: "client-ready",
      id: "1",
      data: { version: "2.0.0", about: { library: "e2e" } },
    }),
  );
  await until(() => messages.some((m) => m.type === "bot-ready"), 15_000, "bot-ready");
  await until(() => sfu.botSpeechBytes() > 0, 30_000, "the greeting on the bot's track");

  // 5. The user asks; the bot answers on its track.
  const before = sfu.botSpeechBytes();
  await sfu.speak(wavTo48kStereo(readFileSync(QUESTION_WAV)));
  await until(() => mock.spoken.includes(ANSWER), 30_000, "the answer to be synthesized");
  await until(() => sfu.botSpeechBytes() > before + 48000 * 4 * 0.2, 30_000, "the answer's audio");
  expect(messages.some((m) => m.type === "user-transcription")).toBe(true);

  // 6. Hang up: the adapters and the browser's tracks are released.
  ws.close();
  await until(
    () =>
      sfu.requests.some((r) => r.path === "/adapters/websocket/close") &&
      sfu.requests.some((r) => /tracks\/close$/.test(r.path)),
    15_000,
    "the call's cleanup",
  );
  const closed = sfu.requests.find((r) => r.path === "/adapters/websocket/close")!;
  expect(closed.body.tracks.length).toBe(2);
  expect(sfu.open("local") || sfu.open("remote")).toBe(false);
}, 180_000);
