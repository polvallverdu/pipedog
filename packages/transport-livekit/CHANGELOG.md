# @pipedog/transport-livekit

## 0.11.0

### Patch Changes

- Updated dependencies [[`96b2e45`](https://github.com/polvallverdu/pipedog/commit/96b2e4550f18d47a683ea635c33db458b0acb5dd), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191), [`bddb1c5`](https://github.com/polvallverdu/pipedog/commit/bddb1c568cfd5b0e9818bc19538b73d5fc83cd40), [`a25889f`](https://github.com/polvallverdu/pipedog/commit/a25889fdb51beffacee1e5e26404dafad662b7d2), [`f57c63e`](https://github.com/polvallverdu/pipedog/commit/f57c63e8b670789bb15574e4ebe3a4ede1eb61c8), [`c23ef57`](https://github.com/polvallverdu/pipedog/commit/c23ef572ea1dd9c8a1ac81a83bf6337df7e1c191)]:
  - @pipedog/core@0.11.0
  - @pipedog/asyncio@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/core@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/core@0.8.0
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

- Updated dependencies [[`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/core@0.7.0
  - @pipedog/asyncio@0.7.0
