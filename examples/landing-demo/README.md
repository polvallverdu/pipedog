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
   ├── WebSocket (Pipecat protobuf + RTVI) ─────┤ Deepgram Flux on Workers AI (STT + turns)
   └── WebRTC ─► Realtime SFU ─► adapters ──────┤ Claude Haiku 5.5 (streamed, tools)
       + RTVI "messages" WebSocket ─────────────┤ Deepgram Aura 2 on Workers AI (speech)
                                                └ RTVI events: transcripts, tool calls, metrics
```

- **Transports.** WebSocket by default: Pipecat's own browser client (`@pipecat-ai/client-js` with
  `@pipecat-ai/websocket-transport`, unchanged) talks to pipedog's `FastAPIWebsocketTransport`
  with the protobuf serializer. WebRTC through Cloudflare Realtime
  (`@pipedog/transport-cloudflare-realtime`): the SFU's WebSocket adapters carry the audio to the
  Durable Object, and RTVI goes over a separate messages socket. The pipeline is the same on both
  (`startDemoAgent` in `src/bot.ts`); only the transport differs.
- **Turns.** Deepgram Flux decides when the user's turn ends: no Silero VAD, no Smart Turn, no
  ONNX in the bundle (about 1 MB gzipped).
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
  unavailable/refused states. `?embed=1` is the compact card for the landing page's iframe;
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
- **Rate limits.** The Rate Limiting binding allows 3 tickets per minute per IP (hashed); the
  budget object allows `MAX_SESSIONS_PER_IP` per 10 minutes. The **global budget** caps sessions
  at once (`MAX_CONCURRENT_SESSIONS`), sessions per UTC day (`MAX_SESSIONS_PER_DAY`) and minutes
  per day (`MAX_MINUTES_PER_DAY`, counting running sessions at their full length). Refusals come
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

You need a Cloudflare account on **Workers Paid** ($5/month): Flux and Aura beyond Workers AI's
free 10,000 neurons a day, Durable Objects with SQLite storage, and the Rate Limiting binding.

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
   `https://polvallverdu.github.io`), the budget and session limits.
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

A full two-minute call, at current list prices:

| | Usage | Cost |
| --- | --- | --- |
| Flux (STT) | 2 audio minutes × $0.0077 | $0.015 |
| Aura 2 (TTS) | ~1,400 characters spoken × $0.030 / 1k | $0.042 |
| Claude Haiku 5.5 | ~10 requests: ~15k input tokens, mostly cache reads, ~700 output | < $0.002 |
| Durable Object | 128 MB × 120 s, plus requests | < $0.001 |
| Realtime (WebRTC only) | a few MB of audio | ~$0 (1,000 GB/month free) |
| **Total** | | **about $0.06** |

Speech dominates. At the default `MAX_MINUTES_PER_DAY` (180 minutes, 90 full calls) the worst day
costs about $5.

## Run it locally

With no accounts at all, against the fakes the tests use:

```sh
bun install
bun run --cwd examples/landing-demo dev:fakes   # http://127.0.0.1:8787
```

Press the mic: a scripted user asks about the weather, the data centre and the docs. For hot
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
- `test/e2e.test.ts`: `wrangler dev` with the fakes (`test/fakes.ts`: Workers AI's Flux and Aura
  through a stand-in binding, the Anthropic API, Open-Meteo, `llms.txt`, `/cdn-cgi/trace`,
  siteverify), a scripted client speaking what Pipecat's client puts on the wire. It checks the
  transcript, the tool call and its result, the reply, the metrics and latency, the data centres,
  a refusal, `end_call`, and what was sent to Claude; the same session over WebRTC against a fake
  SFU (`examples/workers-realtime-voice-agent/test/fake_sfu.ts`), with its tokens and its
  cleanup; tickets (missing, forged, foreign, reused), origins, the rate limit, WebRTC without
  credentials, the kill switch.
- `test/browser.test.ts`: the real page in Chromium against the fakes (WebSocket).
- `test/live.test.ts`: real Workers AI and Claude; runs only with `ANTHROPIC_API_KEY`,
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` set.

Not verified against the real services (no credentials were available): Flux and Aura through
the real AI binding, `/cdn-cgi/trace` from a Durable Object (if it fails, the bot's colo shows as
unknown), Turnstile live, and the WebRTC path against the real Realtime SFU.

## Files

- `src/worker.ts`: routes, the page's headers, ticket issuing and checking.
- `src/session.ts`: `DemoSession`, the Durable Object per session (both transports, Realtime
  signaling, tokens, cleanup).
- `src/budget.ts`, `src/ledger.ts`: `DemoBudget` and its bookkeeping.
- `src/bot.ts`: the pipeline; `src/tools.ts`: the tools; `src/limits.ts`: session caps;
  `src/latency.ts`: voice-to-voice latency without a VAD; `src/security.ts`: tickets, origins,
  Turnstile; `src/colo.ts`: the Durable Object's data centre; `src/config.ts`: the environment.
- `web/`: the page (SvelteKit, Svelte 5), with `src/lib/demo.svelte.ts` (state, both
  transports) and `src/lib/rtc.ts` (the WebRTC client).
- `test/`: tests, fakes, and `dev_fakes.ts`.
