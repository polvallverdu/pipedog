# @pipedog/serializer-vonage

`VonageFrameSerializer` for pipedog, a port of Pipecat's `pipecat.serializers.vonage`. It
translates between pipeline frames and the WebSocket protocol of Vonage's
[Audio Connector](https://developer.vonage.com/en/video/guides/audio-connector): raw 16-bit PCM
in binary messages (16 kHz by default, resampled to and from the pipeline's rate), JSON events in
text messages (`websocket:connected`, `websocket:cleared`, `websocket:notify`, `websocket:dtmf`),
and `{"action": "clear"}` on interruptions.

```sh
bun add @pipedog/serializer-vonage @pipedog/transport-websocket
```

## Runtimes

| class | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `VonageFrameSerializer` | ✅ | ✅ | ✅ | ✅ |

## Example

```ts
import { VonageFrameSerializer } from "@pipedog/serializer-vonage/vonage";

const serializer = new VonageFrameSerializer({
  params: new VonageFrameSerializer.InputParams({ vonageSampleRate: 16000 }),
});
// new FastAPIWebsocketTransport(websocket, new FastAPIWebsocketParams({ serializer, addWavHeader: false, ... }))
```

## Wire compatibility

`test/golden.test.ts` replays vectors recorded from upstream Pipecat
(`tools/golden/telephony.py`): binary audio byte-identical both ways at 16 kHz, events (DTMF
digits as strings or numbers, under `digit` or `dtmf.digit`) with upstream's log lines, `clear`,
and transport messages. Resampled audio is compared by signal-to-noise ratio.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
