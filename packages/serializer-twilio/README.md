# @pipedog/serializer-twilio

`TwilioFrameSerializer` for pipedog, a port of Pipecat's `pipecat.serializers.twilio`. It
translates between pipeline frames and Twilio's
[Media Streams](https://www.twilio.com/docs/voice/media-streams/websocket-messages) WebSocket
protocol: 8 kHz μ-law audio (resampled to and from the pipeline's rate), DTMF, `clear` on
interruptions, and an automatic hang-up of the call through Twilio's REST API on `EndFrame` or
`CancelFrame`.

```sh
bun add @pipedog/serializer-twilio @pipedog/transport-websocket
```

## Runtimes

| class | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `TwilioFrameSerializer` | ✅ | ✅ | ✅ | ✅ |

It is pure: codecs come from core, resampling from core's WASM resampler (a module import on
Workers), and the hang-up call uses `fetch`. `compat/smoke.ts` replays the golden vectors below on
all four runtimes.

## Example

Answer the call with TwiML that connects it to your WebSocket
(`<Connect><Stream url="wss://your.host/ws" /></Connect>`). Twilio sends `connected`, then `start`
with the stream and call SIDs. `parseTelephonyWebsocket` from `@pipedog/runner` reads them:

```ts
import { parseTelephonyWebsocket } from "@pipedog/runner/utils";
import { TwilioFrameSerializer } from "@pipedog/serializer-twilio/twilio";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";

export default websocketFetchHandler(async (websocket) => {
  const [, callData] = await parseTelephonyWebsocket(websocket);
  const serializer = new TwilioFrameSerializer({
    streamSid: callData.streamId ?? "",
    callSid: callData.callId,
    accountSid: process.env.TWILIO_ACCOUNT_SID, // for the hang-up on EndFrame
    authToken: process.env.TWILIO_AUTH_TOKEN,
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
  // ... a pipeline with transport.input() and transport.output()
});
```

[`examples/twilio-phone-bot`](../../examples/twilio-phone-bot) is a complete phone bot, with the
TwiML webhook and tests against a scripted fake Twilio.

Pass `params: new TwilioFrameSerializer.InputParams({ autoHangUp: false })` to leave the call up
when the pipeline ends. With `autoHangUp` (the default), `callSid`, `accountSid` and `authToken`
are required. `region` and `edge` select a regional API host (`api.{edge}.{region}.twilio.com`);
`baseUrl` points the hang-up at a Twilio-compatible API instead.

## Wire compatibility

`test/golden.test.ts` replays vectors recorded from upstream Pipecat with
`tools/golden/telephony.py`:

- **Byte-identical:** `media` events both ways at 8 kHz; DTMF, valid and invalid; `connected`,
  `start`, `mark` and `stop`, which are ignored; `clear`; transport messages as Python's
  `json.dumps` text; the errors upstream raises for messages that are not JSON objects.
- **The hang-up request:** method, path (percent-encoded call SID), form body
  (`Status=completed`), `Content-Type`, `Content-Length` and Basic `Authorization`, for the default
  and a regional host. The log lines for 200, 404 with code 20404 ("already ended"), other 404s,
  404s that aren't JSON and 500s also match.
- **Resampled audio** (pipeline at 16 or 24 kHz) is compared by signal-to-noise ratio, since
  upstream's libsoxr and `@pipedog/resampler-wasm` are not bit-identical.

Differences from upstream: the hang-up uses `fetch` in place of `aiohttp` (cancelled with the
pipeline), and its Basic credentials are UTF-8 encoded where aiohttp uses Latin-1 (the same for
ASCII SIDs and tokens).

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
