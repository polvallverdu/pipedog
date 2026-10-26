// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

import { beforeAll, describe, expect, test } from "bun:test";
import { bytesToBase64 } from "@pipedog/core/utils/base64";
import {
  answerTexml,
  isInvalidDestination,
  parseCallCost,
  parseStatusCallback,
  TelnyxCallRejectedError,
  TelnyxTexmlClient,
  verifyTelnyxSignature,
} from "../src/texml.ts";

describe("verifyTelnyxSignature", () => {
  let publicKey: string;
  let privateKey: CryptoKey;
  const now = 1_790_000_000_000;
  const timestamp = String(now / 1000);
  const body = '{"data":{"event_type":"call.answered"}}';

  async function sign(text: string, ts = timestamp): Promise<string> {
    const data = new TextEncoder().encode(`${ts}|${text}`);
    return bytesToBase64(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, data)));
  }

  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  });

  test("accepts a valid signature, as text or bytes", async () => {
    const signature = await sign(body);
    expect(await verifyTelnyxSignature({ body, signature, timestamp, publicKey, now })).toBe(true);
    expect(
      await verifyTelnyxSignature({
        body: new TextEncoder().encode(body),
        signature,
        timestamp,
        publicKey,
        now,
      }),
    ).toBe(true);
  });

  test("refuses a changed body, a stale timestamp, a bad key or missing headers", async () => {
    const signature = await sign(body);
    const verify = (overrides: Record<string, unknown>) =>
      verifyTelnyxSignature({ body, signature, timestamp, publicKey, now, ...overrides });
    expect(await verify({ body: `${body} ` })).toBe(false);
    expect(await verify({ now: now + 301_000 })).toBe(false);
    expect(await verify({ now: now + 301_000, tolerance: 600 })).toBe(true);
    expect(await verify({ publicKey: "not a key" })).toBe(false);
    expect(await verify({ signature: "AAAA" })).toBe(false);
    expect(await verify({ signature: null })).toBe(false);
    expect(await verify({ timestamp: "12a" })).toBe(false);
    // A signature for another timestamp doesn't carry over.
    const other = String(now / 1000 + 10);
    expect(await verify({ timestamp: other })).toBe(false);
    expect(await verify({ timestamp: other, signature: await sign(body, other) })).toBe(true);
  });
});

describe("answerTexml", () => {
  test("connects the call to the stream, escaping the URL and parameters", () => {
    expect(answerTexml("wss://bot.example/ws?a=1&b=2")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Response><Connect><Stream url="wss://bot.example/ws?a=1&amp;b=2" bidirectionalMode="rtp">' +
        "</Stream></Connect></Response>",
    );
    expect(
      answerTexml("wss://bot.example/ws", {
        codec: "PCMA",
        track: "inbound_track",
        parameters: { campaign: 'a"<b>' },
      }),
    ).toContain(
      'bidirectionalMode="rtp" bidirectionalCodec="PCMA" track="inbound_track">' +
        '<Parameter name="campaign" value="a&quot;&lt;b&gt;"/></Stream>',
    );
  });
});

describe("callbacks", () => {
  test("parseStatusCallback reads CallSid, CallStatus and an unusable number", () => {
    expect(parseStatusCallback("CallSid=v3%3Aabc&CallStatus=ringing&From=%2B34")).toEqual({
      callSid: "v3:abc",
      status: "ringing",
      invalidDestination: false,
      fields: { CallSid: "v3:abc", CallStatus: "ringing", From: "+34" },
    });
    expect(
      parseStatusCallback("CallSid=x&CallStatus=failed&HangupCause=UNALLOCATED_NUMBER")
        ?.invalidDestination,
    ).toBe(true);
    expect(parseStatusCallback("CallSid=x&CallStatus=weird")).toBeNull();
    expect(parseStatusCallback("CallStatus=completed")).toBeNull();
  });

  test("isInvalidDestination", () => {
    expect(isInvalidDestination({ hangup_cause: "busy" })).toBe(false);
    expect(isInvalidDestination({ errors: [{ code: "10016", source: { pointer: "/to" } }] })).toBe(
      true,
    );
    expect(
      isInvalidDestination({ errors: [{ code: "10016", source: { pointer: "/from" } }] }),
    ).toBe(false);
    expect(isInvalidDestination(null)).toBe(false);
  });

  test("parseCallCost", () => {
    const body = JSON.stringify({
      data: {
        event_type: "call.cost",
        payload: {
          call_control_id: "v3:abc",
          status: "success",
          total_cost: "0.0123",
          billed_duration_secs: 60,
          cost_parts: [
            { call_part: "call-control", cost: "0.002", currency: "USD", billed_duration_secs: 60 },
            { call_part: "sip-trunking", cost: "0.0103", currency: "USD" },
          ],
        },
      },
    });
    expect(parseCallCost(body)).toEqual({
      callControlId: "v3:abc",
      status: "success",
      totalCost: 0.0123,
      currency: "USD",
      billedSeconds: 60,
      parts: [
        { part: "call-control", cost: 0.002, billedSeconds: 60 },
        { part: "sip-trunking", cost: 0.0103, billedSeconds: null },
      ],
    });
    expect(parseCallCost(JSON.parse(body))?.callControlId).toBe("v3:abc");
    expect(parseCallCost('{"data":{"event_type":"call.hangup","payload":{}}}')).toBeNull();
    expect(parseCallCost("not json")).toBeNull();
  });
});

describe("TelnyxTexmlClient", () => {
  function client(response: Response, requests: Request[] = []) {
    return new TelnyxTexmlClient({
      apiKey: "KEY",
      accountSid: "acc/1",
      applicationSid: "app",
      from: "+15550000000",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return response;
      },
    });
  }

  test("dial posts the TeXML call with status callbacks", async () => {
    const requests: Request[] = [];
    const call = await client(
      Response.json({ data: { call_control_id: "v3:abc", status: "queued" } }),
      requests,
    ).dial({
      to: "+34600000000",
      url: "https://bot.example/answer",
      statusCallback: "https://bot.example/status",
      extra: { Timeout: 30 },
    });
    expect(call).toMatchObject({ callSid: "v3:abc", status: "queued", invalidDestination: false });
    const [request] = requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe("https://api.telnyx.com/v2/texml/Accounts/acc%2F1/Calls");
    expect(request!.headers.get("authorization")).toBe("Bearer KEY");
    expect(await request!.json()).toEqual({
      ApplicationSid: "app",
      To: "+34600000000",
      From: "+15550000000",
      Url: "https://bot.example/answer",
      StatusCallback: "https://bot.example/status",
      StatusCallbackMethod: "POST",
      StatusCallbackEvent: "initiated ringing answered completed",
      Timeout: 30,
    });
  });

  test("dial refuses a number that is not E.164 without calling Telnyx", async () => {
    const requests: Request[] = [];
    const error = await client(Response.json({}), requests)
      .dial({ to: "600000000", url: "https://x" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TelnyxCallRejectedError);
    expect(error.invalidDestination).toBe(true);
    expect(requests).toHaveLength(0);
  });

  test("a 4xx is a rejection, a 5xx a plain error", async () => {
    const rejected = await client(
      Response.json({ errors: [{ code: "10016", source: { pointer: "/to" } }] }, { status: 422 }),
    )
      .dial({ to: "+34600000000", url: "https://x" })
      .catch((e) => e);
    expect(rejected).toBeInstanceOf(TelnyxCallRejectedError);
    expect(rejected.status).toBe(422);
    expect(rejected.invalidDestination).toBe(true);

    const failed = await client(new Response("oops", { status: 503 }))
      .dial({ to: "+34600000000", url: "https://x" })
      .catch((e) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(TelnyxCallRejectedError);
  });

  test("getCall looks the call up", async () => {
    const requests: Request[] = [];
    const call = await client(
      Response.json({ data: { sid: "v3:abc", status: "completed", hangup_cause: "not_found" } }),
      requests,
    ).getCall("v3:abc");
    expect(requests[0]!.url).toBe(
      "https://api.telnyx.com/v2/texml/Accounts/acc%2F1/Calls/v3%3Aabc",
    );
    expect(call).toMatchObject({
      callSid: "v3:abc",
      status: "completed",
      invalidDestination: true,
    });
  });
});
