# @pipedog/serializer-protobuf

`ProtobufFrameSerializer` for pipedog, a port of Pipecat's `pipecat.serializers.protobuf`. It
speaks Pipecat's `frames.proto` over WebSocket: text, audio, transcription, interruption and
transport messages, the last as a `MessageFrame` holding JSON. It is the default serializer of
the WebSocket transports, and the format the official Pipecat browser client uses.

```sh
bun add @pipedog/serializer-protobuf
```

```ts
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";

const serializer = new ProtobufFrameSerializer();
const bytes = await serializer.serialize(frame); // Uint8Array, or null for other frame types
const decoded = await serializer.deserialize(bytes); // InputAudioRawFrame, InputTransportMessageFrame, ...
```

Pass it as `serializer` to any transport in
[`@pipedog/transport-websocket`](../transport-websocket).

## Runtimes

| class | Bun | Node | Deno | Cloudflare Workers |
|---|:-:|:-:|:-:|:-:|
| `ProtobufFrameSerializer` | ✅ | ✅ | ✅ | ✅ |

The codec is core's `frames/protobufs/frames_pb2`: a hand-written proto3 codec for the same
schema, with no dependencies. `compat/smoke.ts` replays the golden vectors on all four runtimes.

## Wire compatibility

Its wire format is the protocol, so it is checked byte for byte:

- **Upstream** (`test/golden.test.ts`, vectors recorded from upstream Pipecat by
  `tools/golden/serializers.py`). Serializing gives identical bytes for every frame type: unicode
  text, empty and large ids, mono and stereo audio, with and without `pts`, transcriptions, and
  interruptions. Transport messages with nested, unicode, emoji, control-character, float and
  big-int data also match, down to the JSON text, which is written as Python's `json.dumps`
  writes it. Deserializing upstream's bytes, unknown fields included, gives the same frames.
- **The official browser client**, `@pipecat-ai/websocket-transport` 1.7.2
  (`test/client_js_compat.test.ts`, with fixtures from `tools/client-compat/`). Our serializer
  decodes the bytes the client sends: mic audio and RTVI messages. The client decodes ours:
  audio and RTVI messages. The client's `frames.proto` predates `InterruptionFrame`, so it logs
  and ignores interruption, text and transcription frames, from upstream's bots too. A real
  `PipecatClient` was also run headless against `SingleClientWebsocketServerTransport` with
  `tools/client-compat/e2e.ts`.

Differences from upstream:

- `uint64` ids are JS numbers, exact up to 2^53.
- Transport messages are parsed with `JSON.parse`, which rejects the `NaN` and `Infinity` that
  Python's `json` accepts. Such a message is dropped with an error log.
- A string field with invalid UTF-8 is decoded with replacement characters, where upstream's
  protobuf raises `DecodeError`.
- JavaScript has no separate int and float types, so `2.0` arrives as `2`.

## License

BSD 2-Clause, a port of Pipecat (Copyright (c) 2024–2026 Daily).
