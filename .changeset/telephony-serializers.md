---
"@pipedog/serializer-twilio": minor
"@pipedog/serializer-plivo": minor
"@pipedog/serializer-exotel": minor
"@pipedog/serializer-vonage": minor
"@pipedog/serializer-genesys": minor
"@pipedog/runner": minor
---

Telephony: serializers for Twilio, Plivo, Exotel, Vonage and Genesys, and the runner's telephony
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
