---
"@pipedog/inworld": minor
"@pipedog/ultravox": minor
"@pipedog/core": minor
---

Speech-to-speech providers: Inworld and Ultravox.

- `@pipedog/inworld`: `InworldRealtimeLLMService` (Inworld's Realtime API, with its events and
  adapter), and `InworldTTSService` (WebSocket) and `InworldHttpTTSService`.
- `@pipedog/ultravox`: `UltravoxRealtimeLLMService`, with agent, one-shot and join-URL calls.
- `@pipedog/core`: `ServiceSettings.fromMapping()` builds the subclass it is called on again, so
  `TTSSettings.fromMapping({ voice_id: "alice" })` sets `voice` instead of putting every key in
  `extra`.

Both run on Bun, Node, Deno and Cloudflare Workers.
