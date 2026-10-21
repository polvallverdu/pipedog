# @pipedog/serializer-exotel

`ExotelFrameSerializer` for pipedog, a port of Pipecat's `pipecat.serializers.exotel`. It
translates between pipeline frames and Exotel's
[Voicebot/Stream applet](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet)
WebSocket protocol: 16-bit PCM at 8 kHz in base64 `media` events (resampled to and from the
pipeline's rate), DTMF, and `clear` on interruptions. Exotel has no hang-up API call here: the
call ends when the stream does.

```sh
bun add @pipedog/serializer-exotel @pipedog/transport-websocket
```

## Runtimes

| class | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `ExotelFrameSerializer` | ✅ | ✅ | ✅ | ✅ |

## Example

```ts
import { parseTelephonyWebsocket } from "@pipedog/runner/utils";
import { ExotelFrameSerializer } from "@pipedog/serializer-exotel/exotel";

const [, callData] = await parseTelephonyWebsocket(websocket);
const serializer = new ExotelFrameSerializer({
  streamSid: callData.streamId ?? "",
  callSid: callData.callId,
});
// new FastAPIWebsocketTransport(websocket, new FastAPIWebsocketParams({ serializer, addWavHeader: false, ... }))
```

## Wire compatibility

`test/golden.test.ts` replays vectors recorded from upstream Pipecat
(`tools/golden/telephony.py`): `media` events byte-identical both ways at 8 kHz, DTMF and other
events with upstream's log lines, `clear`, and transport messages. Resampled audio is compared by
signal-to-noise ratio (libsoxr upstream, `@pipedog/resampler-wasm` here).

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
