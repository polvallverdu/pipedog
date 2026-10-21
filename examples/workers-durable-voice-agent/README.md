# Parallel voice agents on Cloudflare Durable Objects

Each voice session is one Durable Object. The Worker routes `/api/session/<id>` to the Durable Object
named `<id>`, and that object runs the voice agent for the WebSocket it accepts. Sessions are
independent, so they run in parallel, and Cloudflare places each object on its own.

```text
client ──WebSocket──► Worker ──getByName(id)──► VoiceSession (Durable Object)
                                                   │ FastAPIWebsocketTransport
                                                   │ OpenAI realtime transcription (turns)
                                                   │ OpenAI chat, speech
```

Audio goes over the WebSocket as protobuf frames, the Pipecat wire format. WebRTC isn't available on
Workers (it needs UDP), so this example uses the WebSocket transport.

Turns are detected on OpenAI's side (realtime transcription with server VAD), so the Worker loads no
local models. It's 818 KB gzipped. With Silero VAD and Smart Turn bundled it was 13.7 MB, over
Cloudflare's 10 MB limit, and those models need about 100 MB of memory against a Durable Object's
128 MB.

## Run it

```sh
bun install
bun run --cwd examples/workers-durable-voice-agent dev
```

For local runs, put the key in `examples/workers-durable-voice-agent/.dev.vars`:

```text
OPENAI_API_KEY=sk-...
```

To try it, stream a recording to a session. The client sends the recording as it would arrive from a
microphone, and prints how much speech it received back:

```sh
bun run --cwd examples/workers-durable-voice-agent client ws://127.0.0.1:8787/api/session/alice ../test-mocks/assets/capital_question.wav
```

Run two clients with different session ids to see two agents running in parallel.

## Deploy it

```sh
cd examples/workers-durable-voice-agent
bunx wrangler secret put OPENAI_API_KEY
bun run deploy
```

## Test it

```sh
bun test examples/workers-durable-voice-agent
```

The test runs `wrangler dev` (workerd) with the OpenAI mock from `examples/test-mocks`. It streams
the recorded question into two sessions at once and checks that each session gets its own answer.

## Files

- `src/worker.ts`: the Worker. Routes each session to its Durable Object.
- `src/voice_session.ts`: the Durable Object. Accepts the WebSocket and runs the agent for it.
- `src/bot.ts`: the pipeline, `runVoiceAgent(connection, env)`.
- `client/`: the scripted user, and the WAV helper it uses.
- `wrangler.jsonc`: the Durable Object binding.
