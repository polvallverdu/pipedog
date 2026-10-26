# @pipedog/transport-cloudflare-realtime

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/transport-websocket@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Minor Changes

- [#79](https://github.com/polvallverdu/pipedog/pull/79) [`ac653d6`](https://github.com/polvallverdu/pipedog/commit/ac653d6958c8633721985d2936f21163ea689052) Thanks [@polvallverdu](https://github.com/polvallverdu)! - `@pipedog/transport-cloudflare-realtime` (new, pipedog only): WebRTC users for bots that can't speak WebRTC, such as those in a Cloudflare Worker or Durable Object, through the Cloudflare Realtime SFU.
  
  - `CloudflareRealtimeTransport` takes the SFU's WebSocket adapters: the SFU streams the user's microphone to the bot and publishes the bot's audio as a WebRTC track, as 48 kHz stereo PCM in protobuf packets. The transport converts to the pipeline's rates, paces the bot's audio, stops it on interruptions, and waits for the SFU to reconnect a dropped input adapter. RTVI and other app messages go over a separate WebSocket from the browser.
  - `CloudflareRealtimeAPI` and `CloudflareRealtimeCall` run the Realtime API calls for a call (publish the user's microphone, create the adapters, subscribe the user to the bot, clean up), with `fetch` only.
  - Runs on Bun, Node, Deno and Workers. Tested against a fake SFU built from Cloudflare's documentation, not yet against the real service.
  - New example: `examples/workers-realtime-voice-agent`.

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/transport-websocket@0.9.0
  - @pipedog/asyncio@0.9.0
