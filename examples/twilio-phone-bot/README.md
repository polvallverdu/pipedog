# Phone bot on Twilio

A voice assistant you call on the phone. Twilio streams the call over a WebSocket
([Media Streams](https://www.twilio.com/docs/voice/media-streams)); OpenAI transcribes the
caller, a chat model writes the reply, and OpenAI speech speaks it back into the call. Press `#`
to end the call: the bot finishes speaking and hangs up through Twilio's REST API.

```text
caller ─► Twilio ─► POST /twiml ─► <Connect><Stream url="wss://…/ws">
                        │
caller ◄─► Twilio ◄─► GET /ws (μ-law 8 kHz, JSON events)
                        │  TwilioFrameSerializer
                        ▼
          OpenAI realtime transcription ─► OpenAI chat ─► OpenAI speech
```

Both routes are one fetch handler, `(Request) => Promise<Response>` (`src/app.ts`). The WebSocket
route is `websocketFetchHandler` from `@pipedog/transport-websocket`, so it runs wherever a
request can be upgraded from fetch: Deno (`src/deno.ts`), Cloudflare Workers and Durable Objects,
or a framework route. Turn detection runs on OpenAI's side, so there are no local models to load.

## Run it

You need [Deno](https://deno.com) and [Bun](https://bun.sh) (for the install), an OpenAI API key,
a Twilio account with a phone number, and a public HTTPS URL for your machine (e.g. `ngrok http
8765`).

```sh
bun install
cd examples/twilio-phone-bot
OPENAI_API_KEY=sk-... \
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... \
PUBLIC_URL=https://your-tunnel.ngrok.app \
bun run start
```

In the Twilio console, set your number's **A call comes in** webhook to
`https://your-tunnel.ngrok.app/twiml` (HTTP POST), and call the number.

- `PUBLIC_URL` is the URL Twilio reaches. It builds the stream URL in the TwiML and checks the
  webhook's `X-Twilio-Signature`, which Twilio computes over that URL.
- `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` let the bot hang up and check signatures. Without
  them the call is left to the caller, and webhooks are not checked.
- `PORT` (default 8765), `OPENAI_BASE_URL`, `OPENAI_REALTIME_URL` and `TWILIO_API_BASE_URL` are
  optional.

## Test it

```sh
bun test examples/twilio-phone-bot
```

No API key or phone number needed. The tests run the app against the OpenAI mock from
[`examples/test-mocks`](../test-mocks), a stand-in for Twilio's REST API, and a scripted fake
Twilio (`test/fake_twilio.ts`) that speaks the Media Streams protocol: `connected`, `start` with
the call's SIDs and TwiML parameters, the recorded question ("What is the capital of Germany?") as
20 ms μ-law `media` events in real time, then `#` or `stop`. They check:

- the TwiML webhook: `<Connect><Stream>` with the caller's numbers, signature checks (including
  Twilio's documented example), escaping;
- a call in process, through the fetch handler's `WebSocketPair` upgrade: the greeting, the
  transcribed question, the spoken answer as Twilio `media` events, and the REST hang-up after `#`
  (or none when the caller hangs up first);
- a caller who hangs up before `start`;
- the same call on Deno, `src/deno.ts` serving a real port (skipped without `deno`).

## Files

- `src/app.ts`: the fetch handler: the TwiML webhook and the media WebSocket.
- `src/bot.ts`: one call: `telephonyHandshake`, `TwilioFrameSerializer`, the pipeline.
- `src/deno.ts`: `Deno.serve` entry point.
- `test/`: the scripted fake Twilio and the tests.

On Cloudflare Workers, serve `createPhoneApp(...)` from a Durable Object, one per call, as in
[`workers-durable-voice-agent`](../workers-durable-voice-agent): a Durable Object's CPU limit
applies per message, which suits a call that lasts minutes.
