# @pipedog/serializer-rtvi-client

`RTVIClientSerializer` for pipedog, a port of Pipecat's `pipecat.serializers.rtvi_client`. It
lets a pipeline act as an **RTVI client** of a bot that serves RTVI over a WebSocket, for
example to drive a bot from tests or evals. Outgoing transport messages and audio become RTVI
`client-message`, `send-text` and raw-audio messages. Incoming RTVI events become frames: bot
speaking, transcriptions, LLM and TTS text, function calls, interruptions and audio.

```sh
bun add @pipedog/serializer-rtvi-client @pipedog/transport-websocket
```

Most users want `RTVIClientTransport` from `@pipedog/transport-websocket/rtvi_client`. It uses
this serializer and does the `client-ready` / `bot-ready` handshake:

```ts
import { RTVIClientTransport } from "@pipedog/transport-websocket/rtvi_client";

const transport = new RTVIClientTransport("ws://localhost:7860/ws");
transport.eventHandler("on_bot_ready", async () => console.log("bot ready"));
// new PipelineWorker(new Pipeline([transport.input(), ..., transport.output()]))
```

Or use the serializer with any transport:

```ts
import { RTVIClientSerializer } from "@pipedog/serializer-rtvi-client/rtvi_client";

const serializer = new RTVIClientSerializer();
```

## Runtimes

| class | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `RTVIClientSerializer` | ✅ | ✅ | ✅ | ✅ |

It is pure JSON. `compat/smoke.ts` replays the golden vectors on all four runtimes.

## Wire compatibility

`test/golden.test.ts` replays vectors recorded from upstream Pipecat
(`tools/golden/serializers.py`). Every serialized message has the same JSON text as upstream's,
in Python's `json.dumps` formatting, raw-audio ids included. Every incoming message maps to the
same frame with the same fields, upstream's quirks included: markers given as a dict, a string
or a number, a non-boolean `final`, and messages that are ignored.

The only difference: where upstream raises `AttributeError` or `TypeError` on a malformed
message, this raises a `TypeError`.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
