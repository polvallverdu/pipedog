---
"@pipedog/transport-cloudflare-realtime": minor
---

`@pipedog/transport-cloudflare-realtime` (new, pipedog only): WebRTC users for bots that can't speak WebRTC, such as those in a Cloudflare Worker or Durable Object, through the Cloudflare Realtime SFU.

- `CloudflareRealtimeTransport` takes the SFU's WebSocket adapters: the SFU streams the user's microphone to the bot and publishes the bot's audio as a WebRTC track, as 48 kHz stereo PCM in protobuf packets. The transport converts to the pipeline's rates, paces the bot's audio, stops it on interruptions, and waits for the SFU to reconnect a dropped input adapter. RTVI and other app messages go over a separate WebSocket from the browser.
- `CloudflareRealtimeAPI` and `CloudflareRealtimeCall` run the Realtime API calls for a call (publish the user's microphone, create the adapters, subscribe the user to the bot, clean up), with `fetch` only.
- Runs on Bun, Node, Deno and Workers. Tested against a fake SFU built from Cloudflare's documentation, not yet against the real service.
- New example: `examples/workers-realtime-voice-agent`.
