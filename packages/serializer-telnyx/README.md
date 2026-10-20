# @pipedog/serializer-telnyx

`TelnyxFrameSerializer` for pipedog, a port of Pipecat's `pipecat.serializers.telnyx`. It
translates between pipeline frames and Telnyx's
[WebSocket media streams](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming):
μ-law or A-law audio at 8 kHz (resampled to and from the pipeline's rate), DTMF, `clear` on
interruptions, and an automatic hang-up of the call through Telnyx's REST API on `EndFrame` or
`CancelFrame`.

```sh
bun add @pipedog/serializer-telnyx @pipedog/transport-websocket
```

## Runtimes

| class | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `TelnyxFrameSerializer` | ✅ | ✅ | ✅ | ✅ |

It is pure: codecs come from core, resampling from core's WASM resampler (a module import on
Workers), and the hang-up call uses `fetch`. `compat/smoke.ts` runs the golden vectors below on
all four runtimes.

## Example: a Telnyx media stream bot

Point a TeXML `<Stream url="wss://your.host/telnyx" bidirectionalMode="rtp" />` (or a Call
Control `streaming_start`) at your server. The first messages are `connected` and `start`. Build
the serializer from `start`, then run the pipeline on the same socket.

```ts
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { TelnyxFrameSerializer } from "@pipedog/serializer-telnyx/telnyx";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketServe } from "@pipedog/transport-websocket/serve";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

async function telnyxBot(websocket: WebsocketConnection): Promise<void> {
  // Wait for the `start` event: it carries the stream and call ids.
  let start: any;
  while (!start) {
    const message = JSON.parse(String(await websocket.recv()));
    if (message.event === "start") start = message;
  }

  const serializer = new TelnyxFrameSerializer({
    streamId: start.stream_id,
    callControlId: start.start.call_control_id,
    outboundEncoding: start.start.media_format.encoding, // what Telnyx sends us
    inboundEncoding: "PCMU", // what we send Telnyx
    apiKey: process.env.TELNYX_API_KEY, // for the hang-up on EndFrame
  });

  const transport = new FastAPIWebsocketTransport(
    websocket,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      addWavHeader: false,
      serializer,
    }),
  );
  const worker = new PipelineWorker(
    new Pipeline([transport.input(), /* stt, llm, tts, ... */ transport.output()]),
    { params: new PipelineParams({ audioInSampleRate: 8000, audioOutSampleRate: 8000 }) },
  );
  transport.eventHandler("on_client_disconnected", async () => {
    await worker.cancel();
  });
  const runner = new WorkerRunner({ handleSigint: false });
  await runner.addWorkers(worker);
  await runner.run();
}

await websocketServe({ handler: telnyxBot, host: "0.0.0.0", port: 8765 }); // Bun, Deno, Node + ws
```

On Cloudflare Workers, accept the socket with a `WebSocketPair` and pass
`WebsocketConnection.fromWebSocket(server)` to `telnyxBot`. On Workers, read the API key from
`env`, not `process.env`. See the
[transport README](../transport-websocket#cloudflare-workers-websocketpair).

The pipeline can run at any rate: set `params.sampleRate` or the pipeline's
`audioInSampleRate`, and the serializer resamples between it and Telnyx's 8 kHz (`telnyxSampleRate`).
Pass `params: new TelnyxFrameSerializer.InputParams({ autoHangUp: false })` to leave the call up
when the pipeline ends. With `autoHangUp` (the default), `callControlId` and `apiKey` are required.

## Wire compatibility

`test/golden.test.ts` replays vectors recorded from upstream Pipecat with
`tools/golden/serializers.py`:

- **Byte-identical:** PCMU and PCMA media messages, both directions at 8 kHz; DTMF, valid and
  invalid digits; `connected`, `start`, `stop` and `mark`, which are ignored; `clear`; transport
  messages as Python's `json.dumps` text.
- **The hang-up request:** method, path (with the call id percent-encoded), `Content-Type`,
  `Authorization` and the empty body. Only the HTTP client's own headers differ (User-Agent,
  Accept, Accept-Encoding). The log output for 200, 422 with error 90018 ("already ended"),
  other 422s and 500s also matches.
- **Resampled audio**, with a pipeline at 16 or 24 kHz: upstream uses libsoxr and we use
  `@pipedog/resampler-wasm`. The presets share names but are not bit-identical, so the test
  compares by signal-to-noise ratio after alignment: about 50 dB decoding (8 kHz to the pipeline
  rate) and about 39 dB encoding (bounded by the 8-bit companding). libsoxr also holds back about
  100 ms before its first output; ours streams from the first chunk.

Differences from upstream:

- Upstream raises `AttributeError` for a transport message that is not a dict (a list or a
  string) while the RTVI filter is on, from the base serializer's `should_ignore_frame`. Here,
  core's `shouldIgnoreFrame` treats it as a non-RTVI message and the serializer passes it through.
- The hang-up uses `fetch` in place of `aiohttp`, and it is cancelled with the pipeline.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
