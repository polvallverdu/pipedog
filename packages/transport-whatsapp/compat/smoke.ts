// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Runtime smoke test for tools/compat. Everywhere (workerd included): webhook verification,
// the signature check, the parsed webhook, the API calls and the webhook handler, over a fake
// fetch. On Bun, Node and Deno also a whole call: a werift peer's real SDP offer arrives as a
// connect webhook, the client answers it with a SmallWebRTCConnection, and the pre_accept and
// accept requests carry an SDP answer with only a SHA-256 fingerprint.

import {
  parseWebhookRequest,
  verifyWebhookSignature,
  WhatsAppClient,
  whatsAppWebhookHandler,
} from "@pipedog/transport-whatsapp";

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`transport-whatsapp smoke: ${message}`);
}

function connectBody(sdp: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "calls",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1 555 0100", phone_number_id: "PN1" },
              contacts: [{ profile: { name: "Ada" }, wa_id: "34600000000" }],
              calls: [
                {
                  id: "wacid.smoke",
                  from: "34600000000",
                  to: "15550100",
                  event: "connect",
                  timestamp: "1700000000",
                  direction: "USER_INITIATED",
                  session: { sdp, sdp_type: "offer" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export default async function smoke(): Promise<void> {
  const sent: Array<Record<string, unknown>> = [];
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ messaging_product: "whatsapp", success: true });
  }) as typeof fetch;
  const secret = "app-secret";
  const client = new WhatsAppClient({
    whatsappToken: "token",
    phoneNumberId: "PN1",
    whatsappSecret: secret,
    fetch: fakeFetch,
  });

  // Signature and verification (HMAC through WebCrypto).
  const probe = '{"hello":"world"}';
  check(await verifyWebhookSignature(secret, probe, await sign(secret, probe)), "signature");
  check(!(await verifyWebhookSignature("other", probe, await sign(secret, probe))), "bad secret");
  check(
    (await client.handleVerifyWebhookRequest(
      { "hub.mode": "subscribe", "hub.challenge": "77", "hub.verify_token": "vt" },
      "vt",
    )) === 77,
    "verify challenge",
  );

  // The webhook handler: verification and a bad signature.
  const handler = whatsAppWebhookHandler(client, { verifyToken: "vt" });
  const verified = await handler(
    new Request("https://bot.example/hook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=5"),
  );
  check((await verified.text()) === "5", "handler verify");
  const rejected = await handler(
    new Request("https://bot.example/hook", {
      method: "POST",
      body: connectBody("x"),
      headers: { "X-Hub-Signature-256": "sha256=00" },
    }),
  );
  check(rejected.status === 400, `bad signature status ${rejected.status}`);
  check(parseWebhookRequest(JSON.parse(connectBody("x"))).entry.length === 1, "parse");

  // The API client, on its own.
  await client.whatsappApi.rejectCallToWhatsapp("wacid.other");
  check(sent.at(-1)?.action === "reject", "reject request");

  if (globalThis.navigator?.userAgent === "Cloudflare-Workers") {
    // No WebRTC on Workers: answering a call fails with a clear error, after the API is untouched.
    const body = connectBody(OFFER_SDP);
    let error = "";
    await client
      .handleWebhookRequest(parseWebhookRequest(JSON.parse(body)), {
        rawBody: body,
        sha256Signature: await sign(secret, body),
      })
      .catch((e: Error) => {
        error = e.message;
      });
    check(error.includes("WebRTC"), `workerd error: ${error}`);
    return;
  }

  // A whole call: an SDP offer (as a werift peer makes, without candidates) is answered through
  // a real SmallWebRTCConnection (the default `createConnection`).
  sent.length = 0;
  let connected = 0;
  const body = connectBody(OFFER_SDP);
  const ok = await client.handleWebhookRequest(parseWebhookRequest(JSON.parse(body)), {
    rawBody: body,
    sha256Signature: await sign(secret, body),
    connectionCallback: () => void connected++,
  });
  check(ok && connected === 1, "connect handled");
  check(
    sent.map((s) => s.action).join() === "pre_accept,accept",
    `actions ${sent.map((s) => s.action)}`,
  );
  const session = sent[0]?.session as { sdp: string; sdp_type: string };
  check(session.sdp_type === "answer", "sdp_type");
  check(session.sdp.includes("a=fingerprint:sha-256"), "sha-256 fingerprint");
  check(!/a=fingerprint:sha-(384|512)/.test(session.sdp), "other fingerprints dropped");
  await client.terminateAllCalls();
  check(sent.at(-1)?.action === "terminate", "terminate request");
}

/** An offer made by a werift peer (audio + data channel), candidates removed. */
const OFFER_SDP =
  "v=0\r\no=- 61165250 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1\r\na=extmap-allow-mixed\r\na=msid-semantic:WMS *\r\nm=audio 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:c474\r\na=ice-pwd:243cdd174ba75da81e1e69\r\na=ice-options:trickle\r\na=fingerprint:sha-256 8C:B6:B8:CC:44:A8:27:6F:65:A1:72:37:46:21:15:A8:53:0F:D1:43:0C:B7:F0:D8:6B:94:49:25:41:A2:D8:6C\r\na=setup:actpass\r\na=sendrecv\r\na=mid:0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=rtcp-mux\r\na=ssrc:1249053347 cname:0dd6b2b1-8cbf-4c7f-8268-c9acbfb4dce1\r\na=rtpmap:96 opus/48000/2\r\na=fmtp:96 minptime=10;useinbandfec=1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:c474\r\na=ice-pwd:243cdd174ba75da81e1e69\r\na=ice-options:trickle\r\na=fingerprint:sha-256 8C:B6:B8:CC:44:A8:27:6F:65:A1:72:37:46:21:15:A8:53:0F:D1:43:0C:B7:F0:D8:6B:94:49:25:41:A2:D8:6C\r\na=setup:actpass\r\na=mid:1\r\na=sctp-port:5000\r\na=max-message-size:65536\r\n";
