---
"@pipedog/rime": minor
"@pipedog/fish": minor
"@pipedog/hume": minor
"@pipedog/elevenlabs": minor
---

Four text-to-speech ports, all on Bun, Node, Deno and Cloudflare Workers.

- `@pipedog/rime` (new): `RimeTTSService` (JSON WebSocket with word timestamps), `RimeHttpTTSService` and `RimeV1TTSService` (WebSocket v1, protobuf in binary or JSON envelopes, using Rime's own `@rimelabs/api`). The deprecated `RimeNonJsonTTSService` is not ported.
- `@pipedog/fish` (new): `FishAudioTTSService`, Fish Audio's MessagePack WebSocket API, with `@msgpack/msgpack` in place of `ormsgpack`.
- `@pipedog/hume` (new): `HumeTTSService`, calling Hume's `tts/stream/json` endpoint with `fetch` instead of the Hume SDK, with word timestamps.
- `@pipedog/elevenlabs`: `ElevenLabsDialogueTTSService`, ElevenLabs Text to Dialogue (Eleven v3 and v4 models).

Docs: new Rime, Fish Audio and Hume pages, and a Text to Dialogue section on the ElevenLabs page, each with a runtime matrix.
