---
"@pipedog/runner": minor
---

Port Pipecat's development runner. `createTransport(runnerArgs, transportParams)` builds the
transport the runner arguments call for, reading a phone provider's handshake and building its
serializer; a caller who hangs up mid-handshake is a `TelephonyCallEndedError`, with
`runnerArgs.handshake` set. The `RunnerArguments` classes are ported. `main()` starts the dev
server with upstream's CLI (`-t webrtc|twilio|telnyx|plivo|exotel`, `--proxy`, `--port`, ...): the
prebuilt Pipecat client at `/client`, `/start`, SmallWebRTC's `/api/offer`, the telephony `/ws`
and TwiML/TeXML webhook, uploads and downloads. `createRunnerApp()` returns the same server as a
fetch handler to mount in other frameworks, and `serve()` runs it on Bun, Node and Deno.
