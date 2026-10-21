# @pipedog/transport-whatsapp

WhatsApp Business voice calls for pipedog: a port of Pipecat's `pipecat.transports.whatsapp`
(`WhatsAppClient` and `WhatsAppApi`). A user calls your business number, Meta's Cloud API sends
your webhook a `connect` event with an SDP offer, and the client answers it (`pre_accept`, then
`accept`) over a [SmallWebRTC](../transport-smallwebrtc) connection. You then run a pipeline on
that connection with `SmallWebRTCTransport`, exactly as for a browser client.

```ts
import { WhatsAppClient, whatsAppWebhookHandler } from "@pipedog/transport-whatsapp";
import { SmallWebRTCTransport } from "@pipedog/transport-smallwebrtc/transport";

const client = new WhatsAppClient({
  whatsappToken: process.env.WHATSAPP_TOKEN!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  whatsappSecret: process.env.WHATSAPP_APP_SECRET, // validates X-Hub-Signature-256
  iceServers: ["stun:stun.l.google.com:19302"], // the default
});

const webhook = whatsAppWebhookHandler(client, {
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
  connectionCallback: async (connection, call) => {
    const transport = new SmallWebRTCTransport(connection, new TransportParams({ audioInEnabled: true, audioOutEnabled: true }));
    void runBot(transport, call.from); // your pipeline, as with SmallWebRTC
  },
});

Bun.serve({ port: 8080, routes: { "/webhook": { GET: webhook, POST: webhook } } });
```

Without the helper, call `client.handleVerifyWebhookRequest(params, token)` for Meta's `GET`
verification, and `client.handleWebhookRequest(parseWebhookRequest(JSON.parse(raw)), { connectionCallback, rawBody, sha256Signature })`
for the `POST`. `client.terminateAllCalls()` ends every active call.

## Runtimes

| | Bun | Node ≥ 22 | Deno | Cloudflare Workers |
|---|---|---|---|---|
| answering calls (`connect`, `terminate`, `terminateAllCalls`) | ✅ | ✅ | ✅ | ❌ |
| webhook verification, signature check, `WhatsAppApi` calls, `whatsAppWebhookHandler` (non-call paths) | ✅ | ✅ | ✅ | ✅ |

Needs: for calls, a long-lived server that can send and receive UDP (SmallWebRTC runs on werift).
On Workers there is no WebRTC, so `connect` events fail with a clear error; everything else (the
`GET` verification, HMAC checks through WebCrypto, `answerCallToWhatsapp`, `rejectCallToWhatsapp`,
`terminateCallToWhatsapp`) works, so a Worker can verify and forward webhooks, or reject calls.
The package's `./connection` export resolves to a stub under the `"workerd"` condition so werift
is never bundled into a Worker.

## What Meta needs

- A WhatsApp Business phone number with calling enabled, a webhook subscribed to the `calls`
  field, and a system-user access token (`whatsappToken`).
- Your **app secret** (`whatsappSecret`) lets the client check every `POST`'s
  `X-Hub-Signature-256` (`sha256=` + hex HMAC-SHA256 of the raw body). Pass the *raw* body: it
  must not be re-serialized. Without a secret nothing is checked.
- You have 30 to 60 seconds after `connect` to accept. The client pre-accepts and accepts
  straight away, and keeps only SHA-256 DTLS fingerprints in the answer, which WhatsApp requires.
- Calls go through Graph API `v23.0` (`WhatsAppApi.BASE_URL`; the `baseUrl` option changes it).

## Differences from upstream

- DIVERGENCE: `aiohttp.ClientSession` is the optional `fetch` option.
- Webhook models are TypeScript interfaces with the wire's property names (`from` for upstream's
  `from_`, `sdp_type`, `start_time`, ...), validated by `parseWebhookRequest`.
- The HMAC uses WebCrypto, so the signature check is asynchronous.
- The deprecated one-argument `connectionCallback(connection)` form is not ported.
- `updateWhatsappPhoneNumberId` also updates the calls URL (upstream only stores the value).
- New: `createConnection` (use another connection), `whatsAppWebhookHandler`, `verifyWebhookSignature`
  and `verifyWebhookRequest`.
- Upstream has no tests for these modules. `test/whatsapp.test.ts` is new, and
  `compat/smoke.ts` answers a call with a real `SmallWebRTCConnection`.

## License

BSD 2-Clause.
