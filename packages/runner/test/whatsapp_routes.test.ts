// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The runner's `--whatsapp` routes (`GET`/`POST /whatsapp`). Upstream has no tests for them;
 * these run against a fake Meta Graph API (`fetch`), a fake WebRTC connection and signed
 * webhook bodies.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sleep } from "@pipedog/asyncio";
import {
  asConnection,
  connectWebhook,
  fakeConnection,
  recordingFetch,
  sign,
  terminateWebhook,
} from "../../transport-whatsapp/test/helpers.ts";
import { _setupWhatsappRoutes, _whatsappDeps, RunnerApp } from "../src/run.ts";
import { SmallWebRTCRunnerArguments } from "../src/types.ts";

const ENV = {
  WHATSAPP_APP_SECRET: "app-secret",
  WHATSAPP_PHONE_NUMBER_ID: "PN1",
  WHATSAPP_TOKEN: "tok",
  WHATSAPP_WEBHOOK_VERIFICATION_TOKEN: "verify-me",
};

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _whatsappDeps.clientOptions = () => ({});
});

async function makeApp() {
  const rec = recordingFetch();
  const connections: ReturnType<typeof fakeConnection>[] = [];
  _whatsappDeps.clientOptions = () => ({
    fetch: rec.fetch,
    createConnection: () => {
      const conn = fakeConnection();
      connections.push(conn);
      return asConnection(conn);
    },
  });
  const botCalls: SmallWebRTCRunnerArguments[] = [];
  const app = new RunnerApp({
    botModule: {
      bot: async (runnerArgs) => {
        botCalls.push(runnerArgs as SmallWebRTCRunnerArguments);
      },
    },
  });
  app.fileStorage = null;
  const args = { whatsapp: true };
  await _setupWhatsappRoutes(app, args);
  await app.startup();
  return { app, rec, connections, botCalls, args };
}

async function post(app: RunnerApp, payload: unknown, signature?: string | null) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const sig = signature === undefined ? await sign(ENV.WHATSAPP_APP_SECRET, body) : signature;
  return app.fetch(
    new Request("http://localhost/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sig ? { "x-hub-signature-256": sig } : {}),
      },
      body,
    }),
  );
}

const verifyUrl = (params: Record<string, string>) =>
  `http://localhost/whatsapp?${new URLSearchParams(params)}`;

describe("WhatsApp routes: setup", () => {
  test("mounts GET and POST /whatsapp", async () => {
    const { app } = await makeApp();
    const mounted = app.routes.filter((r) => r.path === "/whatsapp");
    expect(mounted.some((r) => r.methods.has("GET"))).toBe(true);
    expect(mounted.some((r) => r.methods.has("POST"))).toBe(true);
    await app.shutdown();
  });

  test("missing env vars mount nothing", async () => {
    delete process.env.WHATSAPP_TOKEN;
    const app = new RunnerApp();
    await _setupWhatsappRoutes(app, { whatsapp: true });
    expect(app.routes.some((r) => r.path === "/whatsapp")).toBe(false);
  });
});

describe("WhatsApp routes: GET /whatsapp (verification)", () => {
  test("returns the challenge for a valid token", async () => {
    const { app } = await makeApp();
    const response = await app.fetch(
      new Request(
        verifyUrl({
          "hub.mode": "subscribe",
          "hub.challenge": "1158201444",
          "hub.verify_token": "verify-me",
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toBe(1158201444);
    await app.shutdown();
  });

  test("a wrong token is 403", async () => {
    const { app } = await makeApp();
    const response = await app.fetch(
      new Request(
        verifyUrl({ "hub.mode": "subscribe", "hub.challenge": "1", "hub.verify_token": "nope" }),
      ),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).detail).toBe("Verification failed");
    await app.shutdown();
  });

  test("missing parameters are 403", async () => {
    const { app } = await makeApp();
    expect((await app.fetch(new Request("http://localhost/whatsapp"))).status).toBe(403);
    await app.shutdown();
  });

  test("503 before the client is initialized", async () => {
    const app = new RunnerApp();
    await _setupWhatsappRoutes(app, { whatsapp: true });
    const response = await app.fetch(new Request("http://localhost/whatsapp"));
    expect(response.status).toBe(503);
  });
});

describe("WhatsApp routes: POST /whatsapp (events)", () => {
  test("a signed connect event answers the call and starts the bot", async () => {
    const { app, rec, connections, botCalls, args } = await makeApp();
    const response = await post(app, connectWebhook("wacid.7"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "success",
      message: "Webhook processed successfully",
    });

    // pre_accept then accept went to Meta's (fake) Graph API.
    expect(rec.calls.map((c) => c.body.action)).toEqual(["pre_accept", "accept"]);
    expect(rec.calls[0]?.url).toBe("https://graph.facebook.com/v23.0/PN1/calls");
    expect(rec.calls[0]?.headers.Authorization).toBe("Bearer tok");
    expect(rec.calls[0]?.body.call_id).toBe("wacid.7");
    expect(connections).toHaveLength(1);

    // The bot runs with SmallWebRTCRunnerArguments; body is the call metadata.
    await sleep(0.05);
    expect(botCalls).toHaveLength(1);
    const runnerArgs = botCalls[0]!;
    expect(runnerArgs).toBeInstanceOf(SmallWebRTCRunnerArguments);
    expect(runnerArgs.webrtcConnection as unknown).toBe(connections[0] as unknown);
    expect((runnerArgs.body as { id: string }).id).toBe("wacid.7");
    expect((runnerArgs.body as { from: string }).from).toBe("34600000000");
    expect(runnerArgs.cliArgs).toBe(args);
    expect(runnerArgs.sessionId).toBeTruthy();
    await app.shutdown();
  });

  test("a terminate event for an unknown call is handled", async () => {
    const { app } = await makeApp();
    const response = await post(app, terminateWebhook("wacid.unknown"));
    expect(response.status).toBe(200);
    await app.shutdown();
  });

  test("a bad signature is a 500, as upstream", async () => {
    const { app, rec, botCalls } = await makeApp();
    const response = await post(app, connectWebhook(), "sha256=deadbeef");
    expect(response.status).toBe(500);
    expect((await response.json()).detail).toBe("Internal server error processing webhook");
    expect(rec.calls).toHaveLength(0);
    expect(botCalls).toHaveLength(0);
    await app.shutdown();
  });

  test("a missing signature is rejected", async () => {
    const { app, rec } = await makeApp();
    const response = await post(app, connectWebhook(), null);
    expect(response.status).toBe(500);
    expect(rec.calls).toHaveLength(0);
    await app.shutdown();
  });

  test("a wrong object type is 400", async () => {
    const { app } = await makeApp();
    const response = await post(app, { ...connectWebhook(), object: "page" });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toBe("Invalid object type");
    await app.shutdown();
  });

  test("an invalid body is 422", async () => {
    const { app } = await makeApp();
    expect((await post(app, { object: "whatsapp_business_account" })).status).toBe(422);
    expect((await post(app, "not json")).status).toBe(422);
    await app.shutdown();
  });

  test("a webhook with no supported event is 400", async () => {
    const { app } = await makeApp();
    const response = await post(app, {
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [] }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("No supported event found");
    await app.shutdown();
  });

  test("shutdown terminates ongoing calls through the Graph API", async () => {
    const { app, rec, connections } = await makeApp();
    await post(app, connectWebhook("wacid.9"));
    rec.calls.length = 0;
    await app.shutdown();
    expect(rec.calls.map((c) => [c.body.action, c.body.call_id])).toEqual([
      ["terminate", "wacid.9"],
    ]);
    expect(connections[0]?.disconnects).toBe(1);
  });
});
