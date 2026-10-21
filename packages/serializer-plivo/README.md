# @pipedog/serializer-plivo

`PlivoFrameSerializer` for pipedog, a port of Pipecat's `pipecat.serializers.plivo`. It
translates between pipeline frames and Plivo's
[audio streaming](https://www.plivo.com/docs/voice/xml/the-stream-element) WebSocket protocol:
8 kHz μ-law `media` in, `playAudio` out (resampled to and from the pipeline's rate), DTMF,
`clearAudio` on interruptions, and an automatic hang-up of the call through Plivo's REST API on
`EndFrame` or `CancelFrame`.

```sh
bun add @pipedog/serializer-plivo @pipedog/transport-websocket
```

## Runtimes

| class | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `PlivoFrameSerializer` | ✅ | ✅ | ✅ | ✅ |

## Example

Point a `<Stream bidirectional="true" keepCallAlive="true">wss://your.host/ws</Stream>` at your
server. Plivo's `start` message carries the stream and call IDs:

```ts
import { parseTelephonyWebsocket } from "@pipedog/runner/utils";
import { PlivoFrameSerializer } from "@pipedog/serializer-plivo/plivo";

const [, callData] = await parseTelephonyWebsocket(websocket);
const serializer = new PlivoFrameSerializer({
  streamId: callData.streamId ?? "",
  callId: callData.callId,
  authId: env.PLIVO_AUTH_ID, // for the hang-up on EndFrame
  authToken: env.PLIVO_AUTH_TOKEN,
});
// new FastAPIWebsocketTransport(websocket, new FastAPIWebsocketParams({ serializer, addWavHeader: false, ... }))
```

With `autoHangUp` (the default), `callId`, `authId` and `authToken` are required. The hang-up is a
`DELETE https://api.plivo.com/v1/Account/{authId}/Call/{callId}/`; 204 and 404 (already ended) are
logged at debug level, anything else as an error.

## Wire compatibility

`test/golden.test.ts` replays vectors recorded from upstream Pipecat
(`tools/golden/telephony.py`): `playAudio` and decoded `media` byte-identical at 8 kHz, DTMF and
other events with upstream's log lines, transport messages, and the hang-up request (method, path,
Basic authorization) with its log lines. Resampled audio is compared by signal-to-noise ratio. The
hang-up uses `fetch` in place of `aiohttp`.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
