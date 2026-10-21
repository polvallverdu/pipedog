# @pipedog/runner

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
