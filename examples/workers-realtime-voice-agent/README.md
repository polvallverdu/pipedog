# A WebRTC voice agent on Cloudflare Workers, through Cloudflare Realtime

A browser talks to a voice agent over WebRTC. Workers have no UDP, so the bot doesn't speak
WebRTC: Cloudflare Realtime's SFU does, and its WebSocket adapters carry the audio to and from a
Durable Object as PCM. Each call is one Durable Object.

```text
browser ──WebRTC──► Realtime SFU ──WebSocket adapters (PCM)──► VoiceCall (Durable Object)
   │                                                              │ CloudflareRealtimeTransport
   ├──HTTPS signaling (offer / connect / answer)─────────────────►│ OpenAI realtime transcription
   └──WebSocket (RTVI messages)──────────────────────────────────►│ OpenAI chat, speech
```

1. The page publishes the microphone: it posts its SDP offer, the Durable Object creates a Realtime
   session, publishes the track, starts the bot and returns the SFU's answer.
2. Once connected, the page opens the messages WebSocket (RTVI) and posts `connect`. The Durable
   Object creates the two WebSocket adapters; the SFU dials `media/input` and `media/output` on
   the same Durable Object, authenticated with a per-call token in the URL. Then it subscribes the
   page's session to the bot's track and returns the SFU's offer.
3. The page answers; it hears the bot. It sends RTVI `client-ready`, and the bot greets it.
4. Hanging up (or closing the tab) closes the messages socket; the bot stops and the Durable
   Object closes the adapters and tracks. What fails to close is retried from an alarm.

The page (`public/index.html`) is plain JavaScript with no SDK: Pipecat's client SDKs have no
transport for Cloudflare Realtime yet.

## Run it

You need a Realtime SFU app (Dashboard > Realtime > SFU: its App ID and API token) and an OpenAI
key. The SFU must reach your Worker over the internet to dial the adapters, so deploy it:

```sh
cd examples/workers-realtime-voice-agent
bunx wrangler secret put CLOUDFLARE_REALTIME_APP_ID
bunx wrangler secret put CLOUDFLARE_REALTIME_APP_SECRET
bunx wrangler secret put OPENAI_API_KEY
bun run deploy
```

Open the Worker's URL and press Call. With `wrangler dev`, the SFU can't reach `localhost`; expose
it with a tunnel (e.g. `cloudflared tunnel --url http://localhost:8787`) and open the tunnel's
URL, since the adapter endpoints are built from the page's origin.

This example has no user authentication: anyone who can reach it can start calls on your
accounts. Add your own before sharing a deployment.

## Test it

```sh
bun test examples/workers-realtime-voice-agent
```

The test runs `wrangler dev` (workerd) with a fake Realtime SFU (`test/fake_sfu.ts`) and the
OpenAI mock from `examples/test-mocks`. It plays the page's signaling and RTVI; the fake SFU dials
the bot's media endpoints like the real adapters, streams a recorded question as 48 kHz stereo PCM
and collects the bot's audio. Real WebRTC and the real SFU are not part of the test.

## Files

- `src/worker.ts`: the Worker. Routes each call to its Durable Object; the page comes from
  `public/` (static assets).
- `src/voice_call.ts`: the Durable Object. Signaling, the Realtime resources
  (`CloudflareRealtimeCall`), the sockets the SFU dials, cleanup.
- `src/bot.ts`: the pipeline.
- `public/index.html`: the page: WebRTC to the SFU, RTVI over the messages socket.
- `test/`: the end-to-end test and the fake SFU.
