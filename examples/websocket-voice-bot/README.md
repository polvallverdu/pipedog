# Voice bot over WebSocket

A voice assistant you talk to in the browser, over a plain WebSocket. Your speech goes to a
speech-to-text service, the chat model writes a reply, and a speech synthesis service speaks it
back. The services are OpenAI's (default) or Google Gemini's. It is the WebSocket twin of
[`smallwebrtc-voice-bot`](../smallwebrtc-voice-bot): the same bot, the same page and the same tests,
with the transport swapped.

```text
browser mic ──► WebSocket (protobuf) ──► Silero VAD + Smart Turn ──► OpenAI transcription
                                                                          │
browser speaker ◄── WebSocket (protobuf) ◄── OpenAI speech ◄── OpenAI chat ◄┘
```

Audio and RTVI messages go over the socket as protobuf frames, the format
`@pipecat-ai/websocket-transport` speaks. On the server that is `ProtobufFrameSerializer` from
`@pipedog/serializer-protobuf`, behind `FastAPIWebsocketTransport` from
`@pipedog/transport-websocket`.

## WebSocket or WebRTC?

Pick **WebSocket** (this example) when you want the simpler setup:

- No ICE, STUN or TURN. It is one TCP connection to your server, so it goes through corporate
  proxies, load balancers and firewalls that already pass HTTPS.
- It runs where WebRTC can't, such as Cloudflare Workers and Durable Objects (see
  [`workers-durable-voice-agent`](../workers-durable-voice-agent)), which have no UDP.
- It suits server-to-server audio and phone bridges (Twilio, Telnyx, Plivo and others stream calls
  over WebSockets), where there is no browser on the other end.

Pick **WebRTC** ([`smallwebrtc-voice-bot`](../smallwebrtc-voice-bot)) for browser users on real
networks:

- It runs over UDP and copes with packet loss and jitter, where TCP stalls on a lost packet and the
  audio falls behind. Latency stays lower on poor Wi-Fi and mobile networks.
- The browser applies its full echo cancellation, noise suppression and gain control to the call.
- Audio is compressed with Opus, about 32 kbit/s against 256 kbit/s for the 16-bit PCM this example
  sends upstream.

## Run it

You need [Bun](https://bun.sh), an OpenAI API key, and a checkout of this repository:

```sh
bun install
OPENAI_API_KEY=sk-... bun run --cwd examples/websocket-voice-bot start
```

Open <http://localhost:7860>, click **Connect**, allow the microphone, and talk. The bot introduces
itself, then answers what you ask. The page shows the conversation as it goes.

To use Google Gemini instead, set `VOICE_PROVIDER=google` and `GOOGLE_API_KEY`:

```sh
VOICE_PROVIDER=google GOOGLE_API_KEY=... bun run --cwd examples/websocket-voice-bot start
```

Set `OPENAI_BASE_URL` to use an OpenAI-compatible API, and `PORT` to change the port. The server
uses `node:http` and the `ws` package, so `node src/server.ts` (Node 24 or later) starts it too.

Tracing and error alerts are off until you set `OTEL_EXPORTER_OTLP_ENDPOINT` (an OTLP/HTTP traces
endpoint) and `ERROR_WEBHOOK_URL` (pipeline errors are POSTed there as JSON). See
`src/observability.ts`.

## Test it

```sh
bun test examples/websocket-voice-bot
```

The test runs once per provider. It starts the server against a mock of the provider's API (from
`examples/test-mocks`) and drives headless Chromium. The browser's microphone plays a recorded
question ("What is the capital of Germany?"), and the test checks that the bot transcribed it, sent
it to the chat model, that the browser received and played the spoken answer, and that the page's
transcript shows both sides. A third test makes the chat model fail and checks that the error
reaches the alert webhook. It needs no API key, and the page may not load anything from the network
but the SDK.

It needs a Chromium for Playwright: `bunx playwright-core install chromium` in this directory, or
`PIPEDOG_E2E_CHROMIUM=<path>`. Without one it is skipped.

## Files

- `src/bot.ts`: the pipeline, `runVoiceBot(connection, { provider })`. OpenAI or Google services.
- `src/observability.ts`: tracing and error alerts.
- `src/server.ts`: the HTTP server. It serves the page and the `/ws` WebSocket endpoint, and starts
  a bot for each connection.
- `public/index.html`: the page. It loads the unchanged Pipecat browser SDK from esm.sh.
- `test/`: the acceptance test.

`src/bot.ts` and `src/observability.ts` are the WebRTC example's, with only the transport changed,
so each example can be copied out of the repository on its own.
