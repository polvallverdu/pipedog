// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The phone bot end to end, with a scripted fake Twilio (test/fake_twilio.ts)
// and the OpenAI mock from examples/test-mocks, so no API key or phone number is
// needed:
//
// - the TwiML webhook answers with <Connect><Stream>, and checks signatures;
// - in process: the fetch handler's upgrade goes through a stand-in for
//   Workers' WebSocketPair, and the fake caller talks to it;
// - on Bun (src/server.ts, serveFetch) and on Deno when `deno` is installed
//   (src/deno.ts): the app is served on a port,
//   and the fake caller connects over a real WebSocket.
//
// Each call: the bot greets the caller, the caller asks the recorded question
// ("What is the capital of Germany?") as 8 kHz μ-law, and the bot answers.
// Then either the caller presses # and the bot ends the call, hanging it up
// through Twilio's REST API (here a local stand-in), or the caller hangs up
// first, and there is no call left to hang up.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MockOpenAI, startMockOpenAI } from "@pipedog/example-test-mocks/mock_openai";
import { ANSWER, GREETING, SCRIPTED_QUESTION } from "@pipedog/example-test-mocks/mock_provider";
import { connectStreamTwiml, createPhoneApp, twilioSignature } from "../src/app.ts";
import { type CallResult, type ClientSocket, placeCall, wavToPcm8k } from "./fake_twilio.ts";

const QUESTION = wavToPcm8k(
  readFileSync(join(import.meta.dir, "..", "..", "test-mocks", "assets", "capital_question.wav")),
);
const ACCOUNT_SID = "AC_test_account";
const AUTH_TOKEN = "test-auth-token";

/** A stand-in for Twilio's REST API: records hang-up requests. */
interface MockTwilioRest {
  baseUrl: string;
  hangups: { path: string; authorization: string | null; body: string }[];
  stop(): void;
}

function startMockTwilioRest(): MockTwilioRest {
  const mock: MockTwilioRest = { baseUrl: "", hangups: [], stop: () => server.stop(true) };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      mock.hangups.push({
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return Response.json({ sid: "CA", status: "completed" });
    },
  });
  mock.baseUrl = `http://127.0.0.1:${server.port}`;
  return mock;
}

let openai: MockOpenAI;
let twilioRest: MockTwilioRest;

beforeAll(() => {
  openai = startMockOpenAI();
  twilioRest = startMockTwilioRest();
});

afterAll(() => {
  openai.stop();
  twilioRest.stop();
});

function appOptions() {
  return {
    openaiApiKey: "test-key",
    openaiBaseUrl: openai.baseUrl,
    openaiRealtimeUrl: openai.realtimeUrl,
    twilioAccountSid: ACCOUNT_SID,
    twilioAuthToken: AUTH_TOKEN,
    twilioApiBaseUrl: twilioRest.baseUrl,
  };
}

/** Wait for `cond()`, polling. */
async function eventually(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

/** What every call must show, in any runtime. */
async function checkCall(
  result: CallResult,
  callSid: string,
  streamSid: string,
  hangUp: "caller" | "pound",
): Promise<void> {
  // The greeting and the answer reached the caller as Twilio media events.
  expect(result.greetingBytes).toBeGreaterThan(0);
  expect(result.answerBytes).toBeGreaterThan(0);
  const media = result.received.filter((r) => r.message.event === "media");
  for (const { message } of media) {
    expect(Object.keys(message)).toEqual(["event", "streamSid", "media"]);
    expect(message.streamSid).toBe(streamSid);
  }
  // The mock speech is 0.5 s of tone per sentence: 4000 μ-law bytes at 8 kHz.
  expect(result.answerBytes).toBeGreaterThanOrEqual(3000);
  // The question was transcribed, answered, and the answer spoken.
  expect(openai.asked).toContain(SCRIPTED_QUESTION);
  // (Speech is synthesized a sentence at a time.)
  expect(openai.spoken.join(" ")).toContain(GREETING);
  expect(openai.spoken).toContain(ANSWER);
  const path = `/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${callSid}.json`;
  if (hangUp === "caller") {
    // The caller already hung up: the socket is gone, so the serializer never
    // sees the CancelFrame and there is no REST call (as upstream).
    await new Promise((r) => setTimeout(r, 500));
    expect(twilioRest.hangups.some((h) => h.path === path)).toBe(false);
    return;
  }
  // The caller pressed #: the bot ended the call and hung it up through the REST API.
  await eventually(() => twilioRest.hangups.some((h) => h.path === path));
  const hangup = twilioRest.hangups.find((h) => h.path === path);
  expect(hangup?.body).toBe("Status=completed");
  expect(hangup?.authorization).toBe(`Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`);
}

describe("TwiML webhook", () => {
  const app = () => createPhoneApp({ ...appOptions(), publicUrl: "https://bot.example.com" });

  async function webhook(params: Record<string, string>, signature?: string): Promise<Response> {
    const url = "https://bot.example.com/twiml";
    const sig = signature ?? (await twilioSignature(AUTH_TOKEN, url, params));
    return app()(
      new Request("http://127.0.0.1:8765/twiml", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": sig,
        },
        body: new URLSearchParams(params).toString(),
      }),
    );
  }

  test("answers with <Connect><Stream> to the media WebSocket, with the numbers", async () => {
    const response = await webhook({ CallSid: "CA1", From: "+15551234567", To: "+15559876543" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    expect(await response.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>' +
        '<Stream url="wss://bot.example.com/ws">' +
        '<Parameter name="from_number" value="+15551234567" />' +
        '<Parameter name="to_number" value="+15559876543" />' +
        "</Stream></Connect></Response>",
    );
  });

  test("rejects a request whose signature doesn't match", async () => {
    const response = await webhook({ CallSid: "CA1", From: "+1555" }, "bm90IGEgc2lnbmF0dXJl");
    expect(response.status).toBe(403);
  });

  test("matches Twilio's documented signature example", async () => {
    // https://www.twilio.com/docs/usage/security#validating-requests
    const signature = await twilioSignature(
      "12345",
      "https://mycompany.com/myapp.php?foo=1&bar=2",
      {
        CallSid: "CA1234567890ABCDE",
        Caller: "+14158675309",
        Digits: "1234",
        From: "+14158675309",
        To: "+18005551212",
      },
    );
    expect(signature).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
  });

  test("escapes the numbers in the TwiML", () => {
    expect(connectStreamTwiml("wss://h/ws", { from_number: '"<&>' })).toContain(
      'value="&quot;&lt;&amp;&gt;"',
    );
  });

  test("other paths are 404, and /ws needs a WebSocket upgrade", async () => {
    expect((await app()(new Request("http://x/nope"))).status).toBe(404);
    expect((await app()(new Request("http://x/ws"))).status).toBe(426);
  });
});

/** Two linked sockets, as Cloudflare's WebSocketPair gives: what one sends, the other receives. */
class PairSocket extends EventTarget {
  readyState = 1;
  binaryType = "blob";
  peer: PairSocket | null = null;

  accept(): void {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("socket is closed");
    const peer = this.peer as PairSocket;
    queueMicrotask(() => peer.dispatchEvent(new MessageEvent("message", { data })));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    for (const s of [this, this.peer as PairSocket]) {
      s.readyState = 3;
      queueMicrotask(() => s.dispatchEvent(new CloseEvent("close", { code, reason })));
    }
  }
}

class FakeWebSocketPair {
  0: PairSocket;
  1: PairSocket;
  constructor() {
    this[0] = new PairSocket();
    this[1] = new PairSocket();
    this[0].peer = this[1];
    this[1].peer = this[0];
    lastPair = this;
  }
}

let lastPair: FakeWebSocketPair | null = null;

/**
 * Upgrade a request through `app` with the stand-in WebSocketPair in place. Only
 * for the upgrade itself: the bot's own outgoing WebSockets (OpenAI realtime)
 * must not see a WebSocketPair, or they would take the Workers code path.
 */
async function upgradeInProcess(
  app: (request: Request) => Promise<Response>,
): Promise<{ response: Response; pair: FakeWebSocketPair }> {
  const g = globalThis as { WebSocketPair?: unknown };
  const saved = g.WebSocketPair;
  g.WebSocketPair = FakeWebSocketPair;
  let pending: Promise<Response>;
  try {
    // The handler upgrades synchronously, before its first await.
    pending = app(new Request("http://127.0.0.1/ws", { headers: { upgrade: "websocket" } }));
  } finally {
    g.WebSocketPair = saved;
  }
  return { response: await pending, pair: lastPair as FakeWebSocketPair };
}

describe("a call, in process (the fetch handler's WebSocketPair upgrade)", () => {
  for (const hangUp of ["pound", "caller"] as const) {
    const ending = hangUp === "pound" ? "the caller presses #" : "the caller hangs up";
    test(`greets and answers the question, then ${ending}`, async () => {
      const { response, pair } = await upgradeInProcess(createPhoneApp(appOptions()));
      expect(response.status).toBe(101);
      const result = await placeCall(pair[0] as ClientSocket, {
        streamSid: `MZ-inprocess-${hangUp}`,
        callSid: `CA-inprocess-${hangUp}`,
        accountSid: ACCOUNT_SID,
        from: "+15551234567",
        to: "+15559876543",
        question: QUESTION,
        hangUp,
      });
      await checkCall(result, `CA-inprocess-${hangUp}`, `MZ-inprocess-${hangUp}`, hangUp);
    }, 60_000);
  }

  test("a caller who hangs up before the stream starts ends the session cleanly", async () => {
    const { pair } = await upgradeInProcess(createPhoneApp(appOptions()));
    const client = pair[0];
    let serverClosed = false;
    pair[1].addEventListener("close", () => {
      serverClosed = true;
    });
    client.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    client.close(1000, "caller hung up");
    await eventually(() => serverClosed);
    expect(serverClosed).toBe(true);
  });
});

const DENO = Bun.which("deno");

const SERVERS: { name: string; cmd: string[] | null }[] = [
  { name: "Bun (serveFetch: Bun.serve's upgrade)", cmd: [process.execPath, "src/server.ts"] },
  {
    name: "Deno (Deno.serve)",
    cmd: DENO ? [DENO, "run", "--allow-net", "--allow-env", "--allow-read", "src/deno.ts"] : null,
  },
];

for (const { name, cmd } of SERVERS)
  describe.skipIf(!cmd)(`a call, on ${name} and a real WebSocket`, () => {
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let port = 0;
    const tag = name.split(" ")[0]!.toLowerCase();

    beforeAll(async () => {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
      port = probe.port as number;
      probe.stop(true);
      proc = Bun.spawn(cmd!, {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          PORT: String(port),
          HOST: "127.0.0.1",
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: openai.baseUrl,
          OPENAI_REALTIME_URL: openai.realtimeUrl,
          TWILIO_ACCOUNT_SID: ACCOUNT_SID,
          TWILIO_AUTH_TOKEN: AUTH_TOKEN,
          TWILIO_API_BASE_URL: twilioRest.baseUrl,
        },
        stdout: "pipe",
        stderr: "inherit",
      });
      // Ready once it prints its listening line.
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let out = "";
      const deadline = Date.now() + 60_000;
      while (!out.includes("listening") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      if (!out.includes("listening")) throw new Error(`${tag} did not start: ${out}`);
    }, 90_000);

    afterAll(() => {
      proc?.kill();
    });

    test("greets, answers the question, and hangs up when the caller presses #", async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve);
        socket.addEventListener("error", reject);
      });
      const result = await placeCall(socket as ClientSocket, {
        streamSid: `MZ-${tag}`,
        callSid: `CA-${tag}`,
        accountSid: ACCOUNT_SID,
        from: "+15551234567",
        to: "+15559876543",
        question: QUESTION,
        hangUp: "pound",
      });
      await checkCall(result, `CA-${tag}`, `MZ-${tag}`, "pound");
    }, 60_000);
  });
