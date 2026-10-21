# Voice bot over SmallWebRTC

A voice assistant you talk to in the browser. Your speech goes to a speech-to-text service, the chat
model writes a reply, and a speech synthesis service speaks it back. The services are OpenAI's
(default) or Google Gemini's. It mirrors Pipecat's
`examples/transports/transports-small-webrtc.py`, with OpenAI in place of Deepgram and Cartesia.

```text
browser mic ──► SmallWebRTC ──► Silero VAD + Smart Turn ──► OpenAI transcription
                                                                  │
browser speaker ◄── SmallWebRTC ◄── OpenAI speech ◄── OpenAI chat ◄┘
```

## Run it

You need [Bun](https://bun.sh), an OpenAI API key, and a checkout of this repository:

```sh
bun install
OPENAI_API_KEY=sk-... bun run --cwd examples/smallwebrtc-voice-bot start
```

Open <http://localhost:7860>, click **Connect**, allow the microphone, and talk. The bot introduces
itself, then answers what you ask.

To use Google Gemini instead, set `VOICE_PROVIDER=google` and `GOOGLE_API_KEY`:

```sh
VOICE_PROVIDER=google GOOGLE_API_KEY=... bun run --cwd examples/smallwebrtc-voice-bot start
```

Set `OPENAI_BASE_URL` to use an OpenAI-compatible API, and `PORT` to change the port.

Tracing and error alerts are off until you set `OTEL_EXPORTER_OTLP_ENDPOINT` (an OTLP/HTTP traces
endpoint) and `ERROR_WEBHOOK_URL` (pipeline errors are POSTed there as JSON). See
`src/observability.ts`.

## Test it

```sh
bun test examples/smallwebrtc-voice-bot
```

The test runs once per provider. It starts the server against a mock of the provider's API
(`test/mock_openai.ts`, `test/mock_google.ts`) and drives headless Chromium. The browser's microphone plays a recorded question ("What is the capital of Germany?"),
and the test checks that the bot transcribed it, sent it to the chat model, and that the browser
received the spoken answer. It needs no API key.

It needs a Chromium for Playwright: `bunx playwright-core install chromium` in this directory, or
`PIPEDOG_E2E_CHROMIUM=<path>`. Without one it is skipped.

## Files

- `src/bot.ts`: the pipeline, `runVoiceBot(connection, { provider })`. OpenAI or Google services.
- `src/observability.ts`: tracing and error alerts.
- `src/server.ts`: the HTTP server. It serves the page and the SmallWebRTC offer endpoint, and starts
  a bot for each connection.
- `public/index.html`: the page. It loads the unchanged Pipecat browser SDK from esm.sh.
- `test/`: the acceptance test and the mock OpenAI API.
