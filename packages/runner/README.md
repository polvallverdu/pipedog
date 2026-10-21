# @pipedog/runner

Pipecat's runner (`pipecat.runner`) for pipedog. **A partial port:** so far only the telephony
helpers a phone bot needs.

- `parseTelephonyWebsocket(websocket)` reads a phone provider's first WebSocket messages, detects
  the provider (Twilio, Telnyx, Plivo or Exotel) and returns `[transportType, callData]`, with the
  stream and call IDs normalized across providers.
- `telephonyHandshake(websocket)` (a pipedog addition) returns the same parse as a typed outcome:
  `started`, `closed` (the caller hung up before the provider's `start` message) or
  `unrecognized`.
- `CallData`, `TelnyxCallData` and `ExotelCallData`: typed fields (`callData.callId`,
  `callData.fromNumber`) plus dict-style access with the provider's keys (`getItem("call_id")`,
  `get("body", {})`, `has("from")`).

Not ported yet: the development runner (`run.py`, the `main()` server and prebuilt UI),
`create_transport`, and the Daily, LiveKit, MOQ and Vonage Video helpers.

```sh
bun add @pipedog/runner
```

## Runtimes

| export | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `parseTelephonyWebsocket`, `telephonyHandshake`, `CallData` | ✅ | ✅ | ✅ | ✅ |

The socket is anything with Starlette's `receive()`, which `WebsocketConnection` from
`@pipedog/transport-websocket` has, so it works from fetch handlers on every runtime.

## Example

```ts
import { telephonyHandshake } from "@pipedog/runner/utils";
import { websocketFetchHandler } from "@pipedog/transport-websocket/fetch";

export default websocketFetchHandler(async (websocket) => {
  const handshake = await telephonyHandshake(websocket);
  if (handshake.status !== "started") return; // hung up early, or not a phone call
  const { transportType, callData } = handshake;
  console.log(transportType, callData.streamId, callData.callId, callData.fromNumber);
  // build the provider's serializer and the transport, then run the pipeline
});
```

## Differences from upstream

- The parse is cached per socket in a `WeakMap`, not as an attribute on the socket.
- An eval harness's `eval-connect` first message is not detected (`pipecat.evals` is not ported).
- `call_data["call_id"]` is `callData.getItem("call_id")` and `"from" in call_data` is
  `callData.has("from")`.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
