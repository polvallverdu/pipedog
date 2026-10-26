# @pipedog/runner

## 0.10.0

### Patch Changes

- Updated dependencies [[`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e), [`1840a07`](https://github.com/polvallverdu/pipedog/commit/1840a07cff7db6baaab583286f94c1368eba2c3e)]:
  - @pipedog/serializer-telnyx@0.10.0
  - @pipedog/core@0.10.0
  - @pipedog/evals@0.10.0
  - @pipedog/serializer-exotel@0.10.0
  - @pipedog/serializer-plivo@0.10.0
  - @pipedog/serializer-twilio@0.10.0
  - @pipedog/transport-livekit@0.10.0
  - @pipedog/transport-smallwebrtc@0.10.0
  - @pipedog/transport-websocket@0.10.0
  - @pipedog/transport-whatsapp@0.10.0
  - @pipedog/asyncio@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [[`72c00c8`](https://github.com/polvallverdu/pipedog/commit/72c00c876904bd26adb007678179f35e57822557), [`f7dc044`](https://github.com/polvallverdu/pipedog/commit/f7dc044b41e91f3d7d504fb0ae43a7af7fc0ac7d)]:
  - @pipedog/core@0.9.0
  - @pipedog/evals@0.9.0
  - @pipedog/serializer-exotel@0.9.0
  - @pipedog/serializer-plivo@0.9.0
  - @pipedog/serializer-telnyx@0.9.0
  - @pipedog/serializer-twilio@0.9.0
  - @pipedog/transport-livekit@0.9.0
  - @pipedog/transport-smallwebrtc@0.9.0
  - @pipedog/transport-websocket@0.9.0
  - @pipedog/transport-whatsapp@0.9.0
  - @pipedog/asyncio@0.9.0

## 0.8.0

### Patch Changes

- [#69](https://github.com/polvallverdu/pipedog/pull/69) [`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Fixes for apps bundled with `bun build` (and `bun build --compile`) and run without `node_modules`:
  
  - `@pipedog/transport-smallwebrtc` loads `reflect-metadata` first itself (a new dependency, pinned). werift's X.509 code needs it before `tsyringe`, and a bundle that loads the transport lazily, as `@pipedog/runner` does, could put the import after it, which disabled the runner's WebRTC routes. Hosts don't import or externalize `reflect-metadata`; it does not belong in core.
  - `@pipedog/runner` counts its own transports (`@pipedog/transport-websocket`, `@pipedog/transport-smallwebrtc`) as available instead of resolving them by name, which fails in a bundle: every telephony and WebSocket route answered 404.
  - Silero, Smart Turn and RNNoise read their default model or `.wasm` file next to the package's source, which a bundle does not copy. The error now names the `model` option (or `initRnnoise()`) and the `with { type: "file" }` import that fixes it, instead of a bare file-not-found for a path nobody recognizes.
  - Core's Smart Turn fallback warning says that a bundled app has to pass `createLocalSmartTurnAnalyzerV3()` to the turn strategy, since a bundler can't see core's by-name import.
  
  Docs: a Bundling page under Deployment, with the tested `bun build` recipe, a snippet per asset, and what has to stay outside the bundle and why. `examples/bundle-check` bundles and runs a sample bot per configuration in CI.
- Updated dependencies [[`d6e6f45`](https://github.com/polvallverdu/pipedog/commit/d6e6f45c41c7a0aff8f8bdf551f43a8222dc90a8)]:
  - @pipedog/transport-smallwebrtc@0.8.0
  - @pipedog/core@0.8.0
  - @pipedog/evals@0.8.0
  - @pipedog/transport-whatsapp@0.8.0
  - @pipedog/serializer-exotel@0.8.0
  - @pipedog/serializer-plivo@0.8.0
  - @pipedog/serializer-telnyx@0.8.0
  - @pipedog/serializer-twilio@0.8.0
  - @pipedog/transport-livekit@0.8.0
  - @pipedog/transport-websocket@0.8.0
  - @pipedog/asyncio@0.8.0

## 0.7.0

### Minor Changes

- [#51](https://github.com/polvallverdu/pipedog/pull/51) [`fb25ede`](https://github.com/polvallverdu/pipedog/commit/fb25edef3cb316a0581579de92ee4b3a17495d46) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Add `@pipedog/evals`, the port of `pipecat.evals`, to test a bot end to end:
  
  - Scripted and simulated scenarios in YAML, with users simulated by an LLM persona.
  - TTS for the user's audio, with a disk cache.
  - A client transport that connects to the bot as an RTVI client.
  - Expectation matchers and an LLM judge (any `BaseClassifier`, or a factory).
  - Results, multi-bot suites from a manifest, and subprocess sessions.
  - The `pipedog-eval` CLI, with `run`, `judge` and `suite`.
  
  `@pipedog/runner` now detects an eval harness's `eval-connect` message on `/ws` and builds the
  eval transport. `@pipedog/evals` is an optional peer dependency of the runner.

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

- [#50](https://github.com/polvallverdu/pipedog/pull/50) [`6b50380`](https://github.com/polvallverdu/pipedog/commit/6b503801e3c1fdb7de76b715246e5d6b87b4177c) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Ship the prebuilt client. The vendored `prebuilt/dist` was excluded by the repository's `dist/`
  ignore, so published packages had no UI at `/client` and `/` didn't redirect to it.

- [#54](https://github.com/polvallverdu/pipedog/pull/54) [`0b68014`](https://github.com/polvallverdu/pipedog/commit/0b68014db28074bd5ab05e3b6ee25f0b20fc8304) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Wire the WhatsApp transport into the runner: `--whatsapp` mounts `GET` and `POST /whatsapp` (Meta's webhook verification and call events) on `@pipedog/transport-whatsapp`, an optional peer. It reads `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` and `WHATSAPP_WEBHOOK_VERIFICATION_TOKEN`, and starts the bot with `SmallWebRTCRunnerArguments` whose `body` is the call.
- Updated dependencies [[`fb25ede`](https://github.com/polvallverdu/pipedog/commit/fb25edef3cb316a0581579de92ee4b3a17495d46), [`8c8e2b8`](https://github.com/polvallverdu/pipedog/commit/8c8e2b87529dde986404d202ef8738fc317ea513), [`41278ae`](https://github.com/polvallverdu/pipedog/commit/41278ae4842de3534561ca725d18621c3fb27e8a), [`84f2ad1`](https://github.com/polvallverdu/pipedog/commit/84f2ad14d46caf4214cd9a5ddd9d8d3038c39e9e), [`20a84e7`](https://github.com/polvallverdu/pipedog/commit/20a84e741d546e66e0eb7ad9a163c3968a4c042f)]:
  - @pipedog/evals@0.7.0
  - @pipedog/transport-livekit@0.7.0
  - @pipedog/transport-whatsapp@0.7.0
  - @pipedog/core@0.7.0
  - @pipedog/serializer-exotel@0.7.0
  - @pipedog/serializer-plivo@0.7.0
  - @pipedog/serializer-telnyx@0.7.0
  - @pipedog/serializer-twilio@0.7.0
  - @pipedog/transport-smallwebrtc@0.7.0
  - @pipedog/transport-websocket@0.7.0
  - @pipedog/asyncio@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`9f1ce7a`](https://github.com/polvallverdu/pipedog/commit/9f1ce7aea9ae80195d7ff8da0cb591f7910641ac)]:
  - @pipedog/asyncio@0.6.1
  - @pipedog/core@0.6.1
  - @pipedog/serializer-exotel@0.6.1
  - @pipedog/serializer-plivo@0.6.1
  - @pipedog/serializer-telnyx@0.6.1
  - @pipedog/serializer-twilio@0.6.1
  - @pipedog/transport-smallwebrtc@0.6.1
  - @pipedog/transport-websocket@0.6.1

## 0.6.0

### Minor Changes

- [#40](https://github.com/polvallverdu/pipedog/pull/40) [`626112c`](https://github.com/polvallverdu/pipedog/commit/626112cb7f3974ebc85b4604bbbf42ab38554bdd) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Port Pipecat's development runner. `createTransport(runnerArgs, transportParams)` builds the
  transport the runner arguments call for, reading a phone provider's handshake and building its
  serializer; a caller who hangs up mid-handshake is a `TelephonyCallEndedError`, with
  `runnerArgs.handshake` set. The `RunnerArguments` classes are ported. `main()` starts the dev
  server with upstream's CLI (`-t webrtc|twilio|telnyx|plivo|exotel`, `--proxy`, `--port`, ...): the
  prebuilt Pipecat client at `/client`, `/start`, SmallWebRTC's `/api/offer`, the telephony `/ws`
  and TwiML/TeXML webhook, uploads and downloads. `createRunnerApp()` returns the same server as a
  fetch handler to mount in other frameworks, and `serve()` runs it on Bun, Node and Deno.

- [#35](https://github.com/polvallverdu/pipedog/pull/35) [`88ec84e`](https://github.com/polvallverdu/pipedog/commit/88ec84ee7c6b8d258825b9dc3d332b9d6fb72726) Thanks [@polvallverdu](https://github.com/polvallverdu)! - Telephony: serializers for Twilio, Plivo, Exotel, Vonage and Genesys, and the runner's telephony
  helpers.
  
  - `@pipedog/serializer-twilio`: `TwilioFrameSerializer` for Twilio Media Streams (8 kHz μ-law,
    DTMF, `clear`, hang-up through Twilio's REST API on `EndFrame`/`CancelFrame`, regional hosts and
    `baseUrl`).
  - `@pipedog/serializer-plivo`: `PlivoFrameSerializer` for Plivo audio streaming, with REST hang-up.
  - `@pipedog/serializer-exotel`: `ExotelFrameSerializer` for Exotel's Voicebot streams (8 kHz PCM).
  - `@pipedog/serializer-vonage`: `VonageFrameSerializer` for the Vonage Audio Connector (binary
    PCM, JSON events).
  - `@pipedog/serializer-genesys`: `GenesysAudioHookSerializer` for Genesys Cloud AudioHook: the
    open/ping/close handshake, pause and resume, Architect input and output variables, barge-in and
    DTMF.
  - `@pipedog/runner` (partial): `parseTelephonyWebsocket` detects Twilio, Telnyx, Plivo or Exotel
    from the first WebSocket messages and returns typed, dict-compatible `CallData`;
    `telephonyHandshake` returns the same as a typed outcome, including a caller who hangs up before
    the handshake completes.
  
  All run on Bun, Node, Deno and Cloudflare Workers, and replay golden vectors recorded from
  upstream Pipecat.

### Patch Changes

- Updated dependencies [[`b53032d`](https://github.com/polvallverdu/pipedog/commit/b53032d6a46103d5a1c1fd16b3b61dfd38a7bc2b), [`dd4712b`](https://github.com/polvallverdu/pipedog/commit/dd4712bcedc3ac408918651673743fe90520f8db), [`88ec84e`](https://github.com/polvallverdu/pipedog/commit/88ec84ee7c6b8d258825b9dc3d332b9d6fb72726), [`626112c`](https://github.com/polvallverdu/pipedog/commit/626112cb7f3974ebc85b4604bbbf42ab38554bdd)]:
  - @pipedog/asyncio@0.6.0
  - @pipedog/core@0.6.0
  - @pipedog/serializer-twilio@0.6.0
  - @pipedog/serializer-plivo@0.6.0
  - @pipedog/serializer-exotel@0.6.0
  - @pipedog/transport-websocket@0.6.0
  - @pipedog/serializer-telnyx@0.6.0
  - @pipedog/transport-smallwebrtc@0.6.0
