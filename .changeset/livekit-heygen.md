---
"@pipedog/transport-livekit": minor
"@pipedog/heygen": minor
"@pipedog/transport-heygen": minor
"@pipedog/runner": minor
---

LiveKit and HeyGen:

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
