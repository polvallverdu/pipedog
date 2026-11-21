# The landing page's live demo

The talk-to-it voice demo embedded on the docs landing page, running entirely on Cloudflare: one
Worker serves the page (a SvelteKit app) and its API, one Durable Object runs each visitor's
session, and a singleton Durable Object keeps the budget.

```text
                ┌──────────── Worker (one origin) ────────────┐
browser ──GET /─┤ the page: web/ (SvelteKit, static assets)    │
   │            │ /api/status, /api/session (Turnstile→ticket) │
   │            └───────┬───────────────────────┬──────────────┘
   │                    │ reserve / release     │ ticket checked
   │                    ▼                       ▼
   │             DemoBudget (DO, "global")   DemoSession (DO, one per session)
   │                                            │ transport: WebSocket or Cloudflare Realtime
   ├── WebSocket (Pipecat protobuf + RTVI) ─────┤ Silero VAD (in the DO)
   │                                            │ Flux, or Nova-3 + Smart Turn v2, on Workers AI
   └── WebRTC ─► Realtime SFU ─► adapters ──────┤ Claude Haiku 5.5 (streamed, tools)
       + RTVI "messages" WebSocket ─────────────┤ Deepgram Aura 2 on Workers AI (speech)
                                                └ RTVI events: transcripts, tool calls, metrics,
                                                  and the pipeline strip's (src/turn_events.ts)
```

- **Transports.** WebSocket by default: Pipecat's own browser client (`@pipecat-ai/client-js` with
  `@pipecat-ai/websocket-transport`, unchanged) talks to pipedog's `FastAPIWebsocketTransport`
  with the protobuf serializer. WebRTC through Cloudflare Realtime
  (`@pipedog/transport-cloudflare-realtime`): the SFU's WebSocket adapters carry the audio to the
  Durable Object, and RTVI goes over a separate messages socket. The pipeline is the same on both
  (`startDemoAgent` in `src/bot.ts`); only the transport differs.
- **Speech to text, the visitor's pick** (a switch on the page; the choice is signed into the
  session's ticket, and anything unknown is Flux):
  - **Flux** (default, the fastest): Deepgram Flux on Workers AI, English only. It transcribes and
    decides when the user's turn ends (its `EndOfTurn`, which `ExternalUserTurnStopStrategy` turns
    into the end of the turn).
  - **Nova-3**: Deepgram Nova-3 on Workers AI with `language: "multi"`: English and Spanish, mixed
    in one sentence, so an accent or a switch of language doesn't throw it. Smart Turn v2 on Workers
    AI decides whether each pause ends the turn.

  The bot always answers in English (Aura's voice is English).
- **Turns.** Silero VAD runs in the Durable Object in both modes (onnxruntime-web, about 4.7 MB
  gzipped for the whole Worker; the model, 2.3 MB, is served from the static assets and read
  through the `ASSETS` binding, not bundled). Background speech (a TV, people nearby) shouldn't
  count as the user:
  - VAD is stricter than the defaults (`VAD_CONFIDENCE` 0.75, `VAD_START_SECS` 0.25,
    `VAD_MIN_VOLUME_DB` -42 LUFS, against 0.7, 0.2 and about -50), so quieter or shorter speech
    isn't the user. `VAD_STOP_SECS` stays at 0.2, short, as Smart Turn wants.
  - With Flux, the demo's own strategies replace the ones Flux recommends, which would let its
    `StartOfTurn` open the turn (and interrupt the bot) on any speech it hears, a TV included: no
    start strategy resolves Flux's proposed starts, so turns open the same way in both modes.
  - With the bot quiet, VAD starts the turn. Over the bot, it takes `INTERRUPT_MIN_WORDS` (3)
    transcribed words that VAD heard in the last 1.5 s, and never a backchannel ("okay", "mm-hm",
    "vale"): a TV's words, with no speech VAD accepted behind them, can't interrupt it.
  - All five are vars, so they can be tuned without a code change.
- **LLM.** `claude-haiku-5-5` through `@pipedog/anthropic`, streamed, `max_tokens` 400,
  `output_config.effort: "low"` for latency (Haiku 5.5 thinks adaptively at medium effort by
  default), no `temperature`/`top_p`/`top_k` (the API refuses them since 2026-10-21; the service
  sends none unless set), `tool_choice` auto, no prefill. The system prompt and tools are a
  stable prefix, cached for an hour (`enablePromptCaching`, `systemPromptCacheTtl: "1h"`). A
  `stop_reason: "refusal"` is answered with a spoken one-liner.
- **Tools** (`src/tools.ts`, `defineTool` + Zod): `get_weather(city)` (Open-Meteo geocoding and
  forecast, no key), `get_time(timezone)`, `where_am_i()` (the Durable Object's data centre, from
  `/cdn-cgi/trace`, and the visitor's entry data centre, country and city from `request.cf`),
  `search_docs(query)` (the docs' `llms.txt`, cached per isolate for an hour, keyword ranking,
  three results), `end_call()` (says goodbye, ends the session). Requests time out after 4 s,
  tools after 8 s, and results are capped at 1,500 characters.
- **The page** (`web/`) shows the conversation (interim and final transcripts, the bot's text as
  it streams, tool calls as cards), live metrics (voice-to-voice latency, round trip, per-service
  TTFB, data centres, the active transport, WebRTC RTT/jitter from `getStats()`), and clear
  unavailable/refused states. Above them, **the pipeline strip** (`web/src/lib/Pipeline.svelte`):
  mic → VAD → STT → turn → Claude → TTS → speaker, each stage lit while it works (Claude shows the
  tool it's calling) with its latest timing (TTFB, how long the turn took to decide, voice to
  voice), what the STT is hearing, and two moments: speech over the bot that didn't interrupt it,
  and why ("ignored: background speech", "backchannel", "too few words"), and an interruption.
  RTVI's own events drive most of it; `src/turn_events.ts` adds the rest as server messages (VAD,
  the turn decision, interruptions from an observer; ignored speech from the start strategy,
  `DemoMinWordsUserTurnStartStrategy`, the only place that knows why a transcript didn't start a
  turn). `?embed=1` is the compact card for the landing page's iframe;
  `?theme=light|dark` sets the theme, and the landing page updates it with `postMessage`.

## Security

- **Turnstile** before every session. The page gets a token; `POST /api/session` verifies it
  with siteverify (`TURNSTILE_SECRET_KEY`, with the visitor's IP) and returns a **ticket**: HMAC
  SHA-256 (`SESSION_SIGNING_KEY`), valid 60 s, bound to the session id and to a keyed hash of
  the IP. The WebSocket upgrade and the WebRTC `offer` must present it; the session's Durable
  Object accepts one connection ever, so a ticket works once. WebRTC then uses a per-session
  256-bit **call token** (connect, answer, hangup, messages socket) and a separate **adapter
  token** for the SFU's media sockets; both die with the session.
- **Same origin.** The API answers the demo's own origin (plus `ALLOWED_ORIGINS`, for Vite's dev
  server); CORS is only sent to those. The page may be framed only by itself and
  `FRAME_ANCESTORS` (`Content-Security-Policy: frame-ancestors`).
- **Rate limits, per visitor.** The Rate Limiting binding allows 3 tickets per minute per IP
  (hashed); the budget object allows `MAX_CONCURRENT_SESSIONS_PER_IP` sessions at once (1) and
  `MAX_SESSIONS_PER_IP` per 10 minutes. The **global budget** is a cost ceiling:
  `MAX_SPEND_USD_PER_MONTH` ($500 by default) of estimated spend per UTC month, at
  `COST_PER_MINUTE_USD` per session minute ($0.04, above the ~$0.03 that the dearer mode, Nova-3
  with Smart Turn, plus Aura-2 and Haiku 5.5 cost), counting running sessions at their full length so it can't be overrun. Optional:
  sessions and minutes per UTC day (`MAX_SESSIONS_PER_DAY`, `MAX_MINUTES_PER_DAY`) and sessions
  at once across everyone (`MAX_CONCURRENT_SESSIONS`); all 0 (no cap) by default. The estimate
  is not your bill: also set a spending alert in the Cloudflare and Anthropic dashboards. Refusals come
  back as a friendly message the page shows. **Kill switch:** `DEMO_ENABLED` anything but `true`
  refuses everything.
- **Session caps** (`src/limits.ts`): `SESSION_MAX_SECS` (the bot says goodbye 6 s before, then
  ends; a Durable Object alarm is the backstop), `SESSION_IDLE_SECS` with nobody speaking,
  `SESSION_MAX_TURNS`. The context isn't truncated mid-session: Haiku 5.5's thinking blocks are
  only valid in an unedited history, so the turn cap is what bounds it.
- **Privacy.** Debug logs (which carry transcripts) are off unless `DEMO_DEV_MODE`; IPs are only
  used hashed, as rate-limit keys and in tickets; nothing is stored beyond the budget counters.
- **Dev mode** (`DEMO_DEV_MODE=true`) skips Turnstile when no Turnstile secret is set, and lets
  the tests point the services at fakes. Never set it on a deployed Worker.

## Deploy it

You need a Cloudflare account on **Workers Paid** ($5/month): Flux, Nova-3, Smart Turn and Aura beyond
Workers AI's free 10,000 neurons a day, a Worker over the free plan's 3 MB (onnxruntime-web),
Durable Objects with SQLite storage, and the Rate Limiting binding.

1. **Log in:** `bunx wrangler login` (from `examples/landing-demo`).
2. **Turnstile:** Dashboard > Turnstile > Add widget. Hostname: the demo's domain (the
   `*.workers.dev` name or your custom domain, not the docs site: the widget runs on the demo's
   page). Mode: Managed (it shows only when needed). Put the **site key** in `wrangler.jsonc`
   (`TURNSTILE_SITE_KEY`) and the **secret** in a secret (below).
3. **WebRTC (optional):** Dashboard > Realtime > SFU > Create application. Keep its App ID and API
   token. Without them the page offers WebSocket only.
4. **Secrets:**

   ```sh
   cd examples/landing-demo
   bunx wrangler secret put ANTHROPIC_API_KEY
   bunx wrangler secret put TURNSTILE_SECRET_KEY
   openssl rand -base64 48 | bunx wrangler secret put SESSION_SIGNING_KEY
   # WebRTC:
   bunx wrangler secret put CLOUDFLARE_REALTIME_APP_ID
   bunx wrangler secret put CLOUDFLARE_REALTIME_APP_SECRET
   ```

5. **Check the vars** in `wrangler.jsonc`: `FRAME_ANCESTORS` (the docs origin,
   `https://pipedog.polv.dev`), the budget and session limits.
6. **Deploy:** `bun run deploy` (wrangler builds the page first, then uploads the Worker and the
   page together). The demo is at `https://pipedog-landing-demo.<your-subdomain>.workers.dev`.
   For a custom domain: Workers > the Worker > Settings > Domains & Routes > Add custom domain,
   then update the Turnstile widget's hostname.
7. **Embed it in the docs:** in the GitHub repository, Settings > Secrets and variables > Actions >
   Variables, add `DEMO_URL` with the demo's URL. The next docs deploy (`.github/workflows/docs.yml`)
   embeds it; without it the landing page shows a placeholder.

### Watch usage and cost

- Workers AI: Dashboard > AI > Workers AI (neurons per model and day).
- Anthropic: the Console's Usage page; consider a workspace spend limit for this key.
- The Worker's logs: Dashboard > Workers > the Worker > Logs (observability is on), or
  `bunx wrangler tail`. They have no transcripts or IPs.
- Turn it off: set `DEMO_ENABLED` to `"false"` and `bun run deploy` (or edit the variable in the
  dashboard). Lower `MAX_MINUTES_PER_DAY` to cap the daily spend.

### Cost per call

A full two-minute call, at current list prices (the speech to text is one of the first three rows):

| | Usage | Cost |
| --- | --- | --- |
| Flux (STT and turns, WebSocket) | 2 audio minutes × $0.0077 | $0.015 |
| or Nova-3 (STT, WebSocket) | 2 audio minutes × $0.0092 | $0.018 |
| and Smart Turn v2 (with Nova-3) | a few seconds of audio per turn × $0.000338 / min | < $0.001 |
| Aura 2 (TTS) | ~1,400 characters spoken × $0.030 / 1k | $0.042 |
| Claude Haiku 5.5 | ~10 requests: ~15k input tokens, mostly cache reads, ~700 output | < $0.002 |
| Durable Object | 128 MB × 120 s, plus requests | < $0.001 |
| Realtime (WebRTC only) | a few MB of audio | ~$0 (1,000 GB/month free) |
| **Total** | | **about $0.06** (Flux slightly less) |

Speech dominates. At the default `MAX_MINUTES_PER_DAY` (180 minutes, 90 full calls) the worst day
costs about $5.

## Run it locally

With no accounts at all, against the fakes the tests use:

```sh
bun install
bun run --cwd examples/landing-demo dev:fakes   # http://127.0.0.1:8787
```

Press the mic and say anything: each thing you say is transcribed as the next scripted question
(about the weather, the data centre and the docs). Silero VAD runs for real on your microphone. For hot
reload on the page, also run `bun run --cwd examples/landing-demo dev:web` and open
http://localhost:5173 (it proxies `/api` to 8787).

With the real services: copy `.dev.vars.example` to `.dev.vars`, fill it in, and run
`bun run --cwd examples/landing-demo dev` (the AI binding always runs remotely, so you need
`wrangler login`). WebRTC needs the SFU to reach your Worker: deploy it, or use a tunnel.

## Test it

```sh
bun test examples/landing-demo
bun run --cwd examples/landing-demo/web check   # svelte-check
```

- Unit tests: tickets (signing, expiry, tampering, session and IP binding), origins and CORS,
  Turnstile, the config, the budget (concurrency, daily sessions and minutes, per-IP window,
  stale sessions), the session limits, every tool (Open-Meteo and `llms.txt` faked), the colo
  lookup.
- `test/turns.test.ts`: the turn detection settings for both modes, that a TV (words with no VAD
  speech behind them), a backchannel or two words over the bot don't interrupt it while three do,
  and that each is reported with its reason; the mode parsing and prompts; the strip's other events
  (VAD, the turn decision, interruptions).
- `test/e2e.test.ts`: `wrangler dev` with the fakes (`test/fakes.ts`: Workers AI's Flux, Nova-3,
  Smart Turn and Aura through a stand-in binding, the Anthropic API, Open-Meteo, `llms.txt`, `/cdn-cgi/trace`,
  siteverify), a scripted client speaking what Pipecat's client puts on the wire, with a recorded
  question as the microphone, so Silero VAD really runs. A Nova-3 session checks the
  transcript, the tool call and its result, the reply, the metrics and latency, the data centres,
  the strip's events, a refusal, `end_call`, and what was sent to Claude; a Flux session (asked for
  with an unknown mode, so the default) over WebRTC against a fake SFU (`examples/workers-realtime-voice-agent/test/fake_sfu.ts`), with its tokens and its
  cleanup; tickets (missing, forged, foreign, reused), origins, the rate limit, WebRTC without
  credentials, the kill switch.
- `test/browser.test.ts`: the real page in Chromium against the fakes (WebSocket), with the
  recorded question as Chromium's fake microphone: a Flux session (every strip stage lights up and
  the timed ones show a time), and Nova-3 chosen with the switch.
- `test/live.test.ts`: real Workers AI and Claude; runs only with `ANTHROPIC_API_KEY`,
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` set.

Not verified against the real services: Flux with Silero's gating, Nova-3 multilingual and Smart
Turn through the real AI binding, `/cdn-cgi/trace` from a Durable Object (if it fails, the bot's colo shows as
unknown), Turnstile live, and the WebRTC path against the real Realtime SFU.

## Files

- `src/worker.ts`: routes, the page's headers, ticket issuing and checking.
- `src/session.ts`: `DemoSession`, the Durable Object per session (both transports, Realtime
  signaling, tokens, cleanup).
- `src/budget.ts`, `src/ledger.ts`: `DemoBudget` and its bookkeeping.
- `src/bot.ts`: the pipeline and its turn detection; `src/turn_events.ts`: the pipeline strip's
  events; `src/tools.ts`: the tools; `src/limits.ts`:
  session caps; `src/security.ts`: tickets, origins, Turnstile; `src/colo.ts`: the Durable
  Object's data centre; `src/config.ts`: the environment.
- `scripts/copy-models.ts`: copies Silero's model into the page's static assets before the build.
- `web/`: the page (SvelteKit, Svelte 5), with `src/lib/demo.svelte.ts` (state, both
  transports), `src/lib/Pipeline.svelte` (the pipeline strip) and `src/lib/rtc.ts` (the WebRTC
  client).
- `test/`: tests, fakes, and `dev_fakes.ts`.
