---
"@pipedog/core": minor
"@pipedog/google": minor
"@pipedog/langchain": minor
"@pipedog/serializer-protobuf": minor
"@pipedog/serializer-rtvi-client": minor
"@pipedog/serializer-telnyx": minor
"@pipedog/transport-websocket": minor
"@pipedog/transport-smallwebrtc": minor
---

First providers and transports.

- `@pipedog/google`: `GoogleSTTService` (Cloud Speech v2, Chirp 3), `GoogleTTSService` (Chirp 3 HD
  streaming), `GoogleHttpTTSService`, `GeminiTTSService` and `GeminiSTTService` (Gemini Live,
  `gemini-3.5-transcribe-live`). The Gemini classes run everywhere, Workers included; the Cloud
  classes need the optional `@google-cloud/speech` / `@google-cloud/text-to-speech` peers (Bun,
  Node, Deno).
- `@pipedog/langchain`: `LangchainProcessor` for any LangChain `Runnable`, LangGraph graphs included.
- `@pipedog/transport-websocket`: `WebsocketServerTransport`, `WebsocketClientTransport`,
  `FastAPIWebsocketTransport` (bring your own socket: Bun, Deno, Node `ws`, Hono, Cloudflare
  `WebSocketPair`) and `RTVIClientTransport`.
- `@pipedog/transport-smallwebrtc`: `SmallWebRTCTransport` and its request handler, compatible with
  Pipecat's `@pipecat-ai/small-webrtc-transport` client (Bun, Node, Deno).
- Serializers, byte-identical to upstream: `ProtobufFrameSerializer`, `RTVIClientSerializer`,
  `TelnyxFrameSerializer`.
- `@pipedog/core`: `utils/py_json` (Python's `json.dumps`/`json.loads`) and `utils/base64`. The
  protobuf codec rejects invalid UTF-8 in string fields, and `FrameSerializer.shouldIgnoreFrame`
  raises for a transport message that is not a dict, as upstream does.
