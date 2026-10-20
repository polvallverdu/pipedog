# @pipedog/transport-smallwebrtc

Peer-to-peer WebRTC for pipedog: a port of Pipecat's `pipecat.transports.smallwebrtc`
(`SmallWebRTCConnection`, `SmallWebRTCRequestHandler`, `SmallWebRTCTransport`). The browser
connects straight to your bot, with no media server in between. It works with the unchanged
Pipecat browser SDK, [`@pipecat-ai/client-js`](https://www.npmjs.com/package/@pipecat-ai/client-js)
with [`@pipecat-ai/small-webrtc-transport`](https://www.npmjs.com/package/@pipecat-ai/small-webrtc-transport),
and with the Pipecat prebuilt UIs.

```sh
bun add @pipedog/transport-smallwebrtc
```

No native code. Upstream uses aiortc and PyAV. This package uses:

- [werift](https://github.com/shinyoshiaki/werift-webrtc) 0.25.0 for WebRTC (ICE, DTLS, SRTP,
  SCTP data channels, RTP/RTCP, NACK and RTX). It is pure TypeScript.
- [libopus-wasm](https://www.npmjs.com/package/libopus-wasm) 0.4.1 for Opus. It is libopus 1.6.1
  compiled to WebAssembly.

## Runtimes

| | Bun | Node ≥ 22 | Deno | Cloudflare Workers |
|---|---|---|---|---|
| `SmallWebRTCTransport`, `SmallWebRTCConnection`, `SmallWebRTCRequestHandler` | ✅ | ✅ | ✅ | ❌ |

werift needs UDP sockets (`node:dgram`), and Workers have none. To serve a Worker, use a
WebSocket transport.

## Usage

The browser `POST`s its SDP offer to `/api/offer` and `PATCH`es its ICE candidates to the
same URL. This is the contract of Pipecat's development runner. `SmallWebRTCRequestHandler`
answers the offers. `smallWebRTCOfferHandler()` wraps the handler as a `Request` → `Response`
function, and it calls you back with each new connection so you can start a bot on it:

```ts
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { smallWebRTCOfferHandler } from "@pipedog/transport-smallwebrtc/http";
import { SmallWebRTCRequestHandler } from "@pipedog/transport-smallwebrtc/request_handler";
import { SmallWebRTCTransport } from "@pipedog/transport-smallwebrtc/transport";

async function runBot(connection: SmallWebRTCConnection): Promise<void> {
  const transport = new SmallWebRTCTransport(
    connection,
    new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  );
  const worker = new PipelineWorker(
    new Pipeline([transport.input(), stt, userAggregator, llm, tts, transport.output(), assistantAggregator]),
    { params: new PipelineParams({ audioInSampleRate: 16000 }) },
  );
  transport.eventHandler("on_client_disconnected", async () => {
    await worker.cancel();
  });
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(worker);
  await runner.run();
}

const handler = new SmallWebRTCRequestHandler(); // { iceServers, connectionMode, esp32Mode, host }
// Start the bot in the background; the answer is sent once the callback returns.
const offer = smallWebRTCOfferHandler(handler, (connection) => void runBot(connection));
```

### Bun

```ts
Bun.serve({
  port: 7860,
  routes: { "/api/offer": { POST: offer, PATCH: offer } },
});
```

### Node

```ts
import http from "node:http";
import { nodeRequestListener } from "@pipedog/transport-smallwebrtc/http";

http
  .createServer(
    nodeRequestListener((request) =>
      new URL(request.url).pathname === "/api/offer" ? offer(request) : new Response(null, { status: 404 }),
    ),
  )
  .listen(7860);
```

### Hono (Bun, Node, Deno)

```ts
import { Hono } from "hono";

const app = new Hono();
app.on(["POST", "PATCH"], "/api/offer", (c) => offer(c.req.raw));
export default app; // or serve(app) with @hono/node-server, or Deno.serve(app.fetch)
```

### The client

```ts
import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

const client = new PipecatClient({
  transport: new SmallWebRTCTransport({ webrtcRequestParams: { endpoint: "/api/offer" } }),
  enableMic: true,
});
await client.connect();
```

Over the data channel, RTVI works as it does upstream: `bot-ready`, client messages and server
messages, transcripts, metrics. Renegotiation works too, as do `restart_pc` reconnections,
ICE restarts, track status (mute and camera off) and the `ping` keep-alive.

### Without the helper

`SmallWebRTCRequestHandler` is framework-agnostic, as upstream's is:

```ts
const answer = await handler.handleWebRequest(SmallWebRTCRequest.fromDict(body), onConnection);
await handler.handlePatchRequest(SmallWebRTCPatchRequest.fromDict(body));
```

Both methods throw `HTTPException` (with `statusCode` and `detail`) where upstream raises
FastAPI's.

## Options beyond upstream's

`SmallWebRTCConnection` takes these, and `SmallWebRTCRequestHandler` passes them on through
`connectionOptions`:

| option | |
|---|---|
| `videoDecoderFactory` | decodes the peer's camera and screen share (see Video) |
| `videoEncoderFactory` | encodes `OutputImageRawFrame`s sent to the peer (see Video) |
| `opusCodec` | another Opus implementation, e.g. a native binding (`setOpusCodec()` sets the default) |
| `werift` | extra werift `PeerConfig` fields: `icePortRange`, `iceAdditionalHostAddresses`, `iceUseIpv6`, … |

`PIPECAT_SCTP_MAX_CHUNK_SIZE` is honored, as upstream honors it. The default is 1100 bytes of
DATA chunk payload, so a data channel packet fits a 1280-byte MTU. werift's own default
(1191-byte SCTP packets) would fit as well. Large RTVI messages (64 KB is tested) are
fragmented and reassembled.

## Audio

- The user's Opus audio is decoded straight to the pipeline's input rate when Opus supports
  that rate (8, 12, 16, 24 or 48 kHz). For any other rate, the audio is decoded at 48 kHz and
  resampled with core's stream resampler. Upstream always decodes at 48 kHz stereo and resamples.
- A small reorder buffer handles packets that arrive out of order. It adds no delay unless a
  packet is missing, and then waits at most 60 ms. Lost packets are recovered from Opus in-band
  FEC when the next packet carries it, and concealed (PLC) otherwise. Gaps up to 200 ms are
  filled; aiortc's audio jitter buffer skips them instead.
- Bot audio goes out through upstream's `RawAudioTrack`: 10 ms chunks on a clock that doesn't
  drift, with silence when idle (`audioOutAutoSilence`). It is encoded at the output rate when
  Opus supports that rate, and resampled to 48 kHz otherwise. Packets are 20 ms with continuous
  RTP sequence numbers and timestamps, at aiortc's 96 kbps.

## Video

Video is negotiated, and its RTP is received and sent: depayloading, frame assembly in
aiortc's jitter buffer (512 packets for the screen share, as upstream), NACK, PLI and
packetization for VP8 and H.264. However, there is no portable video codec for JavaScript,
so **frames need a codec you provide**:

```ts
const connection = new SmallWebRTCConnection({
  // (codec: "VP8" | "H264") => { decode(frame) => VideoFrame[] }
  videoDecoderFactory: (codec) => myDecoder(codec),
  // (codec) => { encode(frame, { keyframe }) => Uint8Array | null }
  videoEncoderFactory: (codec) => myEncoder(codec),
});
```

- Without a decoder, no `UserImageRawFrame`s are produced: camera and screen-share capture,
  `videoInSources` and image requests get no frames. A warning is logged once. Decoders may
  return `rgb24`, `yuv420p`, `yuvj420p`, `nv12` or `gray` frames, which are converted to RGB
  as upstream converts them with OpenCV.
- Without an encoder, `videoOutEnabled` frames are dropped, and a warning is logged once.

## Differences from upstream

- **aiortc → werift.** The port runs on `rtc.ts`, which wraps werift in the parts of aiortc's API
  that upstream uses (`RTCPeerConnection` events, transceivers, `receiver._enabled`, frame
  tracks). werift reports a `disconnected` connection state, which aiortc never does. It is
  forwarded to the connection's `disconnected` event, as upstream would forward it.
- **mDNS candidates.** Chrome sends `.local` host candidates. Resolving one takes werift about
  a second, so `PATCH /api/offer` adds them in the background and returns at once, and an
  end-of-candidates marker waits behind them. Other candidates are awaited, as upstream awaits
  them.
- **Video codecs are injected** (see above). The decoder side matches upstream once a decoder
  is given. Upstream's `RawVideoTrack` encodes with PyAV; here it needs a `videoEncoderFactory`.
- **`RawAudioTrack.stop()`** completes the writes still queued on it. When `restart_pc` replaces
  the peer connection, the client stops the old track, so a write in progress doesn't wait
  for the output transport's timeout.
- The deprecated `captureParticipantVideo()` forms (no participant id, or a source as the first
  argument) are not ported.
- `runner.utils.smallwebrtc_sdp_munging` (ESP32 mode) is included as `smallwebrtcSdpMunging`
  until the runner is ported.

## Tests

- `test/test_smallwebrtc_transport.test.ts` and `test/test_smallwebrtc_request_handler.test.ts`
  are ported 1:1. The screen-share delivery test connects two peers over localhost with
  stand-in video codecs.
- `test/test_video_in_sources_smallwebrtc.test.ts` holds the SmallWebRTC cases of upstream's
  `test_video_in_sources.py`.
- `test/e2e.test.ts` runs the bot (`test/e2e/bot.ts`) on Bun, Node and Deno, against headless
  Chromium with the real SDK (`test/e2e/page.ts`). It checks bot-ready, RTVI round trips, a
  64 KB message, audio both ways, renegotiation, `restart_pc`, ICE restart and `getStats`. It
  needs a Chromium for playwright-core (`npx playwright install chromium` or
  `PIPEDOG_E2E_CHROMIUM=<path>`) and is skipped without one. `PIPEDOG_E2E=0` skips it.

## License

BSD-2-Clause, like Pipecat. `src/jitter_buffer.ts` and `TimestampMapper` are ported from aiortc
(BSD-3-Clause); see [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md). Dependencies:

- werift: MIT. Its own dependencies are MIT, except tweetnacl (Unlicense) and mediabunny
  (MPL-2.0). werift's main entry doesn't load mediabunny; werift uses it for media containers
  in `werift/nonstandard`. MPL-2.0 is file-level copyleft: you can ship it unmodified, but
  changes to its files must be shared.
- libopus-wasm: MIT. The WebAssembly is built from Xiph.Org's libopus, which is BSD-3-Clause.
  If you redistribute it in a bundle, include libopus's copyright notice (from libopus's
  `COPYING`).
