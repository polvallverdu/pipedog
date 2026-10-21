// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/** The WhatsApp transport against fakes (upstream has no tests for it): API, webhooks, signatures, call flow. */

import { describe, expect, test } from "bun:test";
import {
  parseWebhookRequest,
  verifyWebhookRequest,
  verifyWebhookSignature,
  WebhookValidationError,
  WhatsAppApi,
  WhatsAppClient,
  whatsAppWebhookHandler,
} from "../src/index.ts";
import {
  ANSWER_SDP,
  asConnection,
  connectWebhook,
  fakeConnection,
  OFFER_SDP,
  type Recorded,
  recordingFetch,
  sign,
  terminateWebhook,
} from "./helpers.ts";

function client(extra: Partial<ConstructorParameters<typeof WhatsAppClient>[0]> = {}) {
  const rec = recordingFetch();
  const connections: ReturnType<typeof fakeConnection>[] = [];
  const c = new WhatsAppClient({
    whatsappToken: "tok",
    phoneNumberId: "PN1",
    fetch: rec.fetch,
    createConnection: () => {
      const conn = fakeConnection();
      connections.push(conn);
      return asConnection(conn);
    },
    ...extra,
  });
  return { client: c, rec, connections };
}

describe("WhatsAppApi", () => {
  test("answer, reject and terminate post the Graph API bodies", async () => {
    const rec = recordingFetch();
    const api = new WhatsAppApi({ whatsappToken: "tok", phoneNumberId: "PN1", fetch: rec.fetch });
    await api.answerCallToWhatsapp("c1", "pre_accept", "SDP", "346");
    await api.rejectCallToWhatsapp("c1");
    await api.terminateCallToWhatsapp("c1");
    expect(rec.calls.map((c) => c.url)).toEqual(
      Array(3).fill("https://graph.facebook.com/v23.0/PN1/calls"),
    );
    expect(rec.calls[0]?.headers).toEqual({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    });
    expect(rec.calls[0]?.body).toEqual({
      messaging_product: "whatsapp",
      to: "346",
      action: "pre_accept",
      call_id: "c1",
      session: { sdp: "SDP", sdp_type: "answer" },
    });
    expect(rec.calls[1]?.body).toEqual({
      messaging_product: "whatsapp",
      action: "reject",
      call_id: "c1",
    });
    expect(rec.calls[2]?.body).toEqual({
      messaging_product: "whatsapp",
      action: "terminate",
      call_id: "c1",
    });
  });

  test("token and phone number can be updated", async () => {
    const rec = recordingFetch();
    const api = new WhatsAppApi({ whatsappToken: "a", phoneNumberId: "1", fetch: rec.fetch });
    api.updateWhatsappToken("b");
    api.updateWhatsappPhoneNumberId("2");
    await api.rejectCallToWhatsapp("c");
    expect(rec.calls[0]?.url).toBe("https://graph.facebook.com/v23.0/2/calls");
    expect(rec.calls[0]?.headers.Authorization).toBe("Bearer b");
  });
});

describe("webhook verification", () => {
  const good = { "hub.mode": "subscribe", "hub.challenge": "1158201444", "hub.verify_token": "t" };
  test("returns the challenge as an integer", async () => {
    expect(verifyWebhookRequest(good, "t")).toBe(1158201444);
    expect(await client().client.handleVerifyWebhookRequest(good, "t")).toBe(1158201444);
  });
  test("rejects missing parameters, a wrong mode and a wrong token", () => {
    expect(() => verifyWebhookRequest({ ...good, "hub.challenge": undefined }, "t")).toThrow(
      "Missing",
    );
    expect(() => verifyWebhookRequest({ ...good, "hub.mode": "unsubscribe" }, "t")).toThrow(
      "Invalid hub mode",
    );
    expect(() => verifyWebhookRequest(good, "other")).toThrow("mismatch");
    expect(() => verifyWebhookRequest({ ...good, "hub.challenge": "abc" }, "t")).toThrow(
      "invalid literal",
    );
  });
});

describe("signatures", () => {
  test("verifyWebhookSignature matches the HMAC-SHA256 of the raw body", async () => {
    const body = '{"a":"\\u00e9"}';
    const header = await sign("secret", body);
    expect(await verifyWebhookSignature("secret", body, header)).toBe(true);
    expect(await verifyWebhookSignature("secret", new TextEncoder().encode(body), header)).toBe(
      true,
    );
    expect(await verifyWebhookSignature("wrong", body, header)).toBe(false);
    expect(await verifyWebhookSignature("secret", `${body} `, header)).toBe(false);
    expect(await verifyWebhookSignature("secret", body, header.slice(0, -2))).toBe(false);
  });

  test("a client with a secret needs a valid signature on the raw body", async () => {
    const { client: c, connections } = client({ whatsappSecret: "secret" });
    const raw = JSON.stringify(connectWebhook());
    await expect(c.handleWebhookRequest(connectWebhook())).rejects.toThrow(
      "Missing raw request body",
    );
    await expect(c.handleWebhookRequest(connectWebhook(), { rawBody: raw })).rejects.toThrow(
      "Missing X-Hub-Signature-256",
    );
    await expect(
      c.handleWebhookRequest(connectWebhook(), { rawBody: raw, sha256Signature: "sha256=00" }),
    ).rejects.toThrow("Invalid webhook signature");
    expect(connections).toHaveLength(0);
    expect(
      await c.handleWebhookRequest(connectWebhook(), {
        rawBody: raw,
        sha256Signature: await sign("secret", raw),
      }),
    ).toBe(true);
    expect(connections).toHaveLength(1);
  });
});

describe("calls", () => {
  test("connect: initializes, filters the SDP, pre-accepts, accepts, calls back", async () => {
    const { client: c, rec, connections } = client();
    const seen: string[] = [];
    const ok = await c.handleWebhookRequest(connectWebhook("c1"), {
      connectionCallback: (_conn, call) => void seen.push(`${call.id}:${call.from}`),
    });
    expect(ok).toBe(true);
    expect(connections[0]?.initialized).toEqual([[OFFER_SDP, "offer"]]);
    expect(rec.calls.map((x) => x.body.action)).toEqual(["pre_accept", "accept"]);
    const session = (i: number) => (rec.calls[i] as Recorded).body.session as { sdp: string };
    const sdp = session(0).sdp;
    expect(sdp).toContain("a=fingerprint:sha-256 AA:BB");
    expect(sdp).not.toContain("sha-384");
    expect(sdp).not.toContain("sha-512");
    expect(sdp.endsWith("\r\n")).toBe(true);
    expect(session(1).sdp).toBe(sdp);
    expect(rec.calls[0]?.body.to).toBe("34600000000");
    expect(seen).toEqual(["c1:34600000000"]);
    expect(ANSWER_SDP).toContain("sha-384"); // the fake really offered one
  });

  test("a failing callback does not fail the webhook", async () => {
    const { client: c } = client();
    const ok = await c.handleWebhookRequest(connectWebhook(), {
      connectionCallback: () => {
        throw new Error("bot crashed");
      },
    });
    expect(ok).toBe(true);
  });

  test("a failed pre_accept or accept disconnects and rethrows", async () => {
    for (const failing of ["pre_accept", "accept"]) {
      const rec = recordingFetch((b) =>
        b.action === failing ? { error: { code: 100 } } : { success: true },
      );
      const connections: ReturnType<typeof fakeConnection>[] = [];
      const c = new WhatsAppClient({
        whatsappToken: "t",
        phoneNumberId: "P",
        fetch: rec.fetch,
        createConnection: () => {
          const conn = fakeConnection();
          connections.push(conn);
          return asConnection(conn);
        },
      });
      await expect(c.handleWebhookRequest(connectWebhook())).rejects.toThrow(
        `Failed to ${failing.replace("_", "-")} call`,
      );
      expect(connections[0]?.disconnects).toBe(1);
    }
  });

  test("no SDP answer is an error", async () => {
    const c = new WhatsAppClient({
      whatsappToken: "t",
      phoneNumberId: "P",
      fetch: recordingFetch().fetch,
      createConnection: () => asConnection(fakeConnection(null)),
    });
    await expect(c.handleWebhookRequest(connectWebhook())).rejects.toThrow("no SDP answer");
  });

  test("terminate disconnects the call's connection; the closed event forgets it", async () => {
    const { client: c, connections } = client();
    await c.handleWebhookRequest(connectWebhook("c1"));
    expect(await c.handleWebhookRequest(terminateWebhook("c1"))).toBe(true);
    expect(connections[0]?.disconnects).toBe(1);
    // an unknown call is still handled
    expect(await c.handleWebhookRequest(terminateWebhook("unknown"))).toBe(true);

    await c.handleWebhookRequest(connectWebhook("c2"));
    for (const fn of connections[1]?.handlers.get("closed") ?? []) await fn(connections[1]);
    await c.terminateAllCalls();
    expect(connections[1]?.disconnects).toBe(0); // already forgotten
  });

  test("terminateAllCalls ends every call through the API and disconnects", async () => {
    const { client: c, rec, connections } = client();
    await c.handleWebhookRequest(connectWebhook("a"));
    await c.handleWebhookRequest(connectWebhook("b"));
    rec.calls.length = 0;
    await c.terminateAllCalls();
    expect(rec.calls.map((x) => `${x.body.action}:${x.body.call_id}`).sort()).toEqual([
      "terminate:a",
      "terminate:b",
    ]);
    expect(connections.map((x) => x.disconnects)).toEqual([1, 1]);
    await c.terminateAllCalls(); // nothing left
  });

  test("a webhook without a supported event is an error", async () => {
    const { client: c } = client();
    await expect(
      c.handleWebhookRequest({ object: "whatsapp_business_account", entry: [] }),
    ).rejects.toThrow("No supported event");
  });
});

describe("parseWebhookRequest", () => {
  test("round-trips connect and terminate payloads and drops unknown fields", () => {
    const connect = connectWebhook();
    const wire = JSON.parse(JSON.stringify(connect));
    wire.entry[0].extra = 1;
    expect(parseWebhookRequest(wire)).toEqual(connect);
    expect(
      parseWebhookRequest(JSON.parse(JSON.stringify(terminateWebhook()))).entry[0]?.changes[0]
        ?.value.calls[0]?.event,
    ).toBe("terminate");
  });

  test("accepts contacts without wa_id and calls without from", () => {
    const wire = JSON.parse(JSON.stringify(connectWebhook()));
    const value = wire.entry[0].changes[0].value;
    value.contacts = [{ profile: { name: "x" }, user_id: "US.1" }];
    value.calls[0].from = undefined;
    value.calls[0].from_user_id = "US.1";
    expect(parseWebhookRequest(wire).entry[0]?.changes[0]?.value.calls[0]?.from).toBe("US.1");
  });

  test("rejects malformed bodies", () => {
    expect(() => parseWebhookRequest(null)).toThrow(WebhookValidationError);
    expect(() => parseWebhookRequest({ object: "x" })).toThrow("entry");
    const wire = JSON.parse(JSON.stringify(connectWebhook()));
    delete wire.entry[0].changes[0].value.calls[0].session.sdp;
    expect(() => parseWebhookRequest(wire)).toThrow("sdp");
  });
});

describe("whatsAppWebhookHandler", () => {
  const url = "https://bot.example/webhook";
  test("GET verifies, POST handles with the signature", async () => {
    const { client: c, connections } = client({ whatsappSecret: "s" });
    const handler = whatsAppWebhookHandler(c, { verifyToken: "vt" });

    const ok = await handler(
      new Request(`${url}?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`),
    );
    expect([ok.status, await ok.text()]).toEqual([200, "42"]);
    expect(
      (await handler(new Request(`${url}?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42`)))
        .status,
    ).toBe(403);

    const body = JSON.stringify(connectWebhook());
    const post = (sig: string | null, b = body) =>
      handler(
        new Request(url, {
          method: "POST",
          body: b,
          headers: sig ? { "X-Hub-Signature-256": sig } : {},
        }),
      );
    expect((await post(await sign("s", body))).status).toBe(200);
    expect(connections).toHaveLength(1);
    expect((await post("sha256=bad")).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect((await post(null, "not json")).status).toBe(400);
    expect((await handler(new Request(url, { method: "PUT" }))).status).toBe(405);
  });
});
