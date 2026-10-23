# @pipedog/transport-cloudflare-realtime

A pipedog transport for [Cloudflare Realtime](https://developers.cloudflare.com/realtime/sfu/)
(the SFU, formerly Calls). Users talk over WebRTC from a browser or an app; the bot runs where
WebRTC isn't available, such as a Cloudflare Worker or Durable Object, and never speaks WebRTC
itself. This package is pipedog's own: Pipecat has no counterpart.

```sh
bun add @pipedog/transport-cloudflare-realtime
```

## How it works

```text
browser ──WebRTC (Opus)──► Realtime SFU ──WebSocket adapter (PCM)──► bot: input socket
browser ◄──WebRTC (Opus)── Realtime SFU ◄──WebSocket adapter (PCM)── bot: output socket
browser ◄────────────── WebSocket (RTVI JSON) ─────────────────────► bot: messages socket
```

- The SFU's [WebSocket adapter](https://developers.cloudflare.com/realtime/sfu/features/media-transport-adapters/websocket-adapter/)
  converts between WebRTC tracks and PCM. **The SFU dials the bot**, on two endpoints you choose:
  one adapter (`location: "remote"`) streams the user's microphone to the bot, the other
  (`location: "local"`) takes the bot's audio and publishes it as a new track.
- Audio on the adapters is 48 kHz stereo 16-bit PCM, one protobuf packet per WebSocket message
  (`packet.ts`). The transport converts to and from the pipeline's rates and channels, and paces
  the bot's audio in real time; an interruption stops it at once.
- App messages (RTVI) can't ride the adapters, and SFU DataChannels need a WebRTC peer, so they
  go over a third WebSocket the browser opens to the bot, carrying the same JSON messages
  SmallWebRTC sends over its data channel.

The transport doesn't listen: your server hands it each socket, with
`transport.acceptSocket(role, request)`.

## Usage

```ts
import { CloudflareRealtimeAPI, CloudflareRealtimeCall } from "@pipedog/transport-cloudflare-realtime/api";
import {
  CloudflareRealtimeParams,
  CloudflareRealtimeTransport,
} from "@pipedog/transport-cloudflare-realtime/transport";

const transport = new CloudflareRealtimeTransport(
  new CloudflareRealtimeParams({ audioInEnabled: true, audioOutEnabled: true }),
);
// ... build the pipeline with transport.input() and transport.output(), and run it.

// Signaling, on your backend (the app secret stays there):
const call = new CloudflareRealtimeCall(new CloudflareRealtimeAPI({ appId, appSecret }));
const { sessionDescription: answer } = await call.publishUser(browserOffer, micMid);
// ... once the browser is connected:
const { sessionDescription: offer } = await call.connectBot({
  input: `wss://example.com/call/123/media/input?token=${token}`,
  output: `wss://example.com/call/123/media/output?token=${token}`,
});
// ... the browser answers:
await call.renegotiate(browserAnswer);
// ... at the end:
await call.close();

// The endpoints the SFU dials, in your fetch handler (check the token first):
return transport.acceptSocket("input", request); // or "output", or "messages" for the browser
```

See [`examples/workers-realtime-voice-agent`](../../examples/workers-realtime-voice-agent) for a
complete Worker, Durable Object and browser page, and the
[docs page](https://polvallverdu.github.io/pipedog/docs/transports/cloudflare-realtime/).

## Events

| Event | When |
|---|---|
| `on_client_connected(transport, client)` | both adapter sockets are attached |
| `on_client_disconnected(transport, client)` | the input adapter didn't reconnect within `inputReconnectTimeout` (the SFU retries for up to 15 s), the output adapter closed, or the messages socket closed (`disconnectOnMessagesClose`, on by default) |
| `on_app_message(transport, message, sender)` | a JSON message arrived on the messages socket |

## Runtimes

| class / function | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `CloudflareRealtimeTransport` (`/transport`), `attachSocket()` | ✅ | ✅ | ✅ | ✅ |
| `acceptSocket()` | ✅ pass the server, serve with `bunWebSocket` | ✅ with `serveFetch()` and `ws` | ✅ | ✅ `WebSocketPair`, in a Worker or a Durable Object |
| `CloudflareRealtimeAPI`, `CloudflareRealtimeCall` (`/api`) | ✅ | ✅ | ✅ | ✅ |
| packet codec (`/packet`) | ✅ | ✅ | ✅ | ✅ |

`compat/smoke.ts` (`bun run compat`) runs a pipeline against a fake SFU on all four runtimes,
over `WebSocketPair` sockets on workerd, where it also checks `acceptSocket()`. On Bun, Node and
Deno, `acceptSocket()` upgrades with `@pipedog/transport-websocket`'s `upgradeWebSocket()`, which
is tested in that package. The example's end-to-end test runs the Worker and Durable
Object in `wrangler dev` against a fake SFU that dials the bot's endpoints like the real one.

Not verified against the real Cloudflare Realtime service yet: the tests use fakes built from
Cloudflare's documentation. `test/api.test.ts` has a live test that runs when
`CLOUDFLARE_REALTIME_APP_ID` and `CLOUDFLARE_REALTIME_APP_SECRET` are set.

## RealtimeKit

RealtimeKit meetings are out of scope: RealtimeKit's agent participant can't send or receive
audio yet ("planned" in Cloudflare's capability matrix). This transport works with the SFU
directly.
