# @pipedog/transport-heygen

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
  - @pipedog/heygen@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#48](https://github.com/polvallverdu/pipedog/pull/48) [`8c8e2b8`](https://github.com/polvallverdu/pipedog/commit/8c8e2b87529dde986404d202ef8738fc317ea513) Thanks [@polvallverdu](https://github.com/polvallverdu)! - LiveKit and HeyGen:
  
  - `@pipedog/transport-livekit`: `LiveKitTransport` joins a LiveKit room (a self-hosted server or
    LiveKit Cloud) with audio in and out, video in (camera and screen share) and out, data messages
    (RTVI), participant events and SIP DTMF, plus `LiveKitRESTHelper`. Media runs on LiveKit's
    native Node SDK, `@livekit/rtc-node`, an optional peer dependency loaded when the transport is
    set up (prebuilt for macOS, glibc Linux and Windows x64).
  - `@pipedog/heygen`: `HeyGenVideoService` and `HeyGenClient` for LiveAvatar and the Interactive
    Avatar API. `@pipedog/transport-heygen`: `HeyGenTransport`, which joins the avatar's room.
  - `@pipedog/runner`: `-t livekit` (`POST /start` mints a bot and a user token and starts the bot
    with `LiveKitRunnerArguments`), `createTransport()` for LiveKit, and `@pipedog/runner/livekit`
    (`generateToken`, `generateSessionTokens`, `configure`).
  
  The new packages run on Bun, Node and Deno; not on Cloudflare Workers.

### Patch Changes

- Updated dependencies [[`8c8e2b8`](https://github.com/polvallverdu/pipedog/commit/8c8e2b87529dde986404d202ef8738fc317ea513), [`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/heygen@0.7.0
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
