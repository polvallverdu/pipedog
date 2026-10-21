# pipedog

[![CI](https://github.com/polvallverdu/pipedog/actions/workflows/ci.yml/badge.svg)](https://github.com/polvallverdu/pipedog/actions/workflows/ci.yml)
[![Docs](https://github.com/polvallverdu/pipedog/actions/workflows/docs.yml/badge.svg)](https://polvallverdu.github.io/pipedog/)
[![npm](https://img.shields.io/npm/v/@pipedog/core?label=%40pipedog%2Fcore)](https://www.npmjs.com/package/@pipedog/core)
[![License: BSD-2-Clause](https://img.shields.io/badge/license-BSD--2--Clause-blue.svg)](LICENSE)

pipedog is a TypeScript port of [Pipecat](https://github.com/pipecat-ai/pipecat), the framework for
real-time voice and multimodal conversational AI. You build a bot as a pipeline of frame processors
(transport in, speech-to-text, LLM, text-to-speech, transport out) and it runs on Bun, Node, Deno
and Cloudflare Workers. The API mirrors Pipecat's: the same classes, frames, events, module paths
and wire protocols, with camelCase members. So Pipecat's client SDKs (`@pipecat-ai/client-js`,
`@pipecat-ai/small-webrtc-transport`, voice-ui-kit) work against a pipedog bot unchanged.

> **Unofficial.** pipedog is an independent project. It is not affiliated with or endorsed by Daily
> or the Pipecat project. The name is a nod to Pipecat; the code is a port of it, under the same BSD
> 2-Clause license.

**Docs:** <https://polvallverdu.github.io/pipedog/>

## Quickstart

A voice assistant you talk to in the browser, with OpenAI speech-to-text, chat and text-to-speech
over SmallWebRTC.

### Install

```sh
bun add @pipedog/core @pipedog/asyncio @pipedog/openai @pipedog/transport-smallwebrtc \
  @pipedog/audio-silero @pipedog/audio-smart-turn onnxruntime-node
```

(`npm install`, `pnpm add` and `deno add npm:...` work the same way.) `onnxruntime-node` runs the
local Silero VAD and Smart Turn models; without it, `onnxruntime-web@1.30.0` (WASM) is used instead.

### Write the bot

`bot.ts`:

```ts
import { readFileSync } from "node:fs";
import http from "node:http";
import { createTask } from "@pipedog/asyncio";
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { LLMRunFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { nodeRequestListener, smallWebRTCOfferHandler } from "@pipedog/transport-smallwebrtc/http";
import { SmallWebRTCRequestHandler } from "@pipedog/transport-smallwebrtc/request_handler";
import { SmallWebRTCTransport } from "@pipedog/transport-smallwebrtc/transport";

const apiKey = process.env.OPENAI_API_KEY ?? null;

/** One conversation over one WebRTC connection. */
async function runBot(connection: SmallWebRTCConnection): Promise<void> {
  const transport = new SmallWebRTCTransport(
    connection,
    new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  );

  const stt = new OpenAISTTService({ apiKey });
  const llm = new OpenAILLMService({
    apiKey,
    settings: new OpenAILLMSettings({
      systemInstruction: "You are a helpful voice assistant. Keep replies short; they are spoken.",
    }),
  });
  const tts = new OpenAITTSService({ apiKey, sampleRate: 24000 });

  // Silero VAD hears speech; the default turn strategy (Smart Turn) decides when the user is done.
  const context = new LLMContext();
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({ vadAnalyzer: new SileroVADAnalyzer() }),
  });

  const pipeline = new Pipeline([
    transport.input(),
    stt,
    aggregators.user(),
    llm,
    tts,
    transport.output(),
    aggregators.assistant(),
  ]);

  const worker = new PipelineWorker(pipeline, {
    params: new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 24000 }),
  });
  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  await runner.addWorkers(worker);

  transport.eventHandler("on_client_connected", async () => {
    context.addMessage({ role: "developer", content: "Please introduce yourself to the user." });
    await worker.queueFrames([new LLMRunFrame()]);
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await runner.cancel();
  });

  await runner.run();
}

// POST /api/offer is the SmallWebRTC signalling endpoint the Pipecat browser SDK talks to.
const offer = smallWebRTCOfferHandler(new SmallWebRTCRequestHandler(), (connection) => {
  createTask(() => runBot(connection), "voice-bot");
});
const page = readFileSync("index.html");

http
  .createServer(
    nodeRequestListener(async (request) => {
      if (new URL(request.url).pathname === "/api/offer") return offer(request);
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }),
  )
  .listen(7860, () => console.log("Open http://localhost:7860"));
```

For `index.html`, copy [`examples/smallwebrtc-voice-bot/public/index.html`](examples/smallwebrtc-voice-bot/public/index.html):
a Connect button and the unchanged Pipecat browser SDK, pointed at `/api/offer`.

### Run it

```sh
OPENAI_API_KEY=sk-... bun bot.ts
```

Open <http://localhost:7860>, click **Connect**, allow the microphone, and talk.

To run the same bot from a checkout, with a Google Gemini option, tracing and a headless-browser
test, see [`examples/smallwebrtc-voice-bot`](examples/smallwebrtc-voice-bot) and the
[voice bot guide](https://polvallverdu.github.io/pipedog/docs/voice-bot/). For a pipeline with no
API keys at all, see the [docs quickstart](https://polvallverdu.github.io/pipedog/docs/quickstart/).

## Runtimes

`@pipedog/core` and `@pipedog/asyncio` are runtime-agnostic: no `node:*` imports (other than
`node:async_hooks`), no `Buffer`, no runtime-specific APIs. Runtime support per package is recorded
from real runs by the compat harness (`bun run compat`), not by hand.

| Runtime | Supported | Notes |
| --- | --- | --- |
| Bun | Yes | The development runtime. Runs the TypeScript directly. |
| Node.js | Yes, 22 or later | |
| Deno | Yes | |
| Cloudflare Workers | Yes, with `nodejs_compat` | No WebRTC (no UDP): use the WebSocket transport. Models are loaded from R2, KV or `fetch`, not bundled. See [Workers](https://polvallverdu.github.io/pipedog/docs/workers/). |

Every package below is verified on all four, except `@pipedog/transport-smallwebrtc` (not Workers:
no UDP), `@pipedog/transport-livekit`, `@pipedog/heygen` and `@pipedog/transport-heygen` (not
Workers: LiveKit's media SDK is a native addon), `@pipedog/transport-local` (spawns sox or ffmpeg: Bun,
Node and Deno), `@pipedog/transport-whatsapp` (on Workers only the webhook, signature and API parts
work: answering a call needs WebRTC) and `@pipedog/mcp` (a stdio tool for Bun and Node). A few entry points inside verified
packages don't run on Workers: `@pipedog/aws`'s `SageMakerBidiClient` (HTTP/2), Google's gRPC
Cloud Speech and Text-to-Speech services, and the servers that listen on a port (the runner's
`main()` and `serve()`, `serveFetch`). Each package's README has its own runtime table.
Details: [Runtimes & compatibility](https://polvallverdu.github.io/pipedog/docs/runtimes/).

## Packages

All packages are published under the `@pipedog` scope and released together at one version.

| Package | What |
| --- | --- |
| [`@pipedog/core`](packages/core) | Frames, processors, pipelines, workers, bus, observers, RTVI, turns, and the base services, transports and serializers. |
| [`@pipedog/asyncio`](packages/asyncio) | asyncio semantics for JavaScript: tasks, cooperative cancellation, queues, events. |
| [`@pipedog/openai`](packages/openai) | OpenAI services: LLM, Responses, Realtime, STT, TTS, image. |
| [`@pipedog/anthropic`](packages/anthropic) | Anthropic Claude LLM service. |
| [`@pipedog/baseten`](packages/baseten), [`@pipedog/cerebras`](packages/cerebras), [`@pipedog/crusoe`](packages/crusoe), [`@pipedog/deepseek`](packages/deepseek), [`@pipedog/fireworks`](packages/fireworks), [`@pipedog/nebius`](packages/nebius), [`@pipedog/novita`](packages/novita), [`@pipedog/ollama`](packages/ollama), [`@pipedog/openrouter`](packages/openrouter), [`@pipedog/perplexity`](packages/perplexity), [`@pipedog/qwen`](packages/qwen), [`@pipedog/sambanova`](packages/sambanova) | OpenAI-compatible LLM services, one package per provider, each a small subclass of `OpenAILLMService`. |
| [`@pipedog/groq`](packages/groq), [`@pipedog/mistral`](packages/mistral), [`@pipedog/together`](packages/together), [`@pipedog/xai`](packages/xai) | OpenAI-compatible LLM services with the provider's speech-to-text and text-to-speech; `@pipedog/xai` also has Grok Voice Agent speech-to-speech. `@pipedog/grok` is the deprecated alias of `@pipedog/xai/llm` and `@pipedog/xai/realtime`. |
| [`@pipedog/azure`](packages/azure) | Azure services: Azure OpenAI (LLM, Realtime, image), Voice Live, Azure Speech STT and TTS. |
| [`@pipedog/google`](packages/google) | Google services: Gemini (LLM, Live), Cloud Speech-to-Text, Cloud Text-to-Speech. |
| [`@pipedog/deepgram`](packages/deepgram) | Deepgram services: STT, TTS, Flux STT and TTS. |
| [`@pipedog/cartesia`](packages/cartesia) | Cartesia services: STT, Ink-2 turn-based STT, WebSocket and HTTP TTS. |
| [`@pipedog/elevenlabs`](packages/elevenlabs) | ElevenLabs services: STT, Realtime STT, WebSocket and HTTP TTS. |
| [`@pipedog/inworld`](packages/inworld) | Inworld services: Realtime speech-to-speech, WebSocket and HTTP TTS. |
| [`@pipedog/ultravox`](packages/ultravox) | Ultravox realtime speech-to-speech service. |
| [`@pipedog/aws`](packages/aws) | AWS services: Bedrock LLM, Transcribe STT, Polly TTS, Nova Sonic, AgentCore, and the SageMaker streaming client. |
| [`@pipedog/whisper`](packages/whisper) | Base STT service for Whisper-compatible APIs, shared by the services that speak that protocol. |
| [`@pipedog/langchain`](packages/langchain) | LangChain integration (`LangchainProcessor`). |
| [`@pipedog/flows`](packages/flows) | Structured conversations from nodes, functions and actions (Pipecat Flows), as code or YAML/JSON configs. |
| [`@pipedog/transport-smallwebrtc`](packages/transport-smallwebrtc) | Peer-to-peer WebRTC transport (werift, Opus via WASM) for the Pipecat browser SDK's `SmallWebRTCTransport`. |
| [`@pipedog/transport-livekit`](packages/transport-livekit) | LiveKit transport: joins a LiveKit room (your server or LiveKit Cloud) with audio, video, data messages and SIP DTMF, on LiveKit's native Node SDK. |
| [`@pipedog/heygen`](packages/heygen), [`@pipedog/transport-heygen`](packages/transport-heygen) | HeyGen avatars (LiveAvatar and Interactive Avatar): `HeyGenVideoService` and `HeyGenTransport`. |
| [`@pipedog/transport-whatsapp`](packages/transport-whatsapp) | WhatsApp Business voice calls (`WhatsAppClient`): Meta calling webhooks, signature checks, accept/reject/terminate, on SmallWebRTC. |
| [`@pipedog/transport-local`](packages/transport-local) | `LocalAudioTransport`: the machine's microphone and speakers through sox or ffmpeg, no native addon. |
| [`@pipedog/transport-websocket`](packages/transport-websocket) | WebSocket transports: client, server and bring-your-own-socket, with servers for Bun, Node and Deno, and fetch handlers for Workers. |
| [`@pipedog/serializer-protobuf`](packages/serializer-protobuf) | `ProtobufFrameSerializer`, wire-compatible with Pipecat's `frames.proto`. |
| [`@pipedog/serializer-rtvi-client`](packages/serializer-rtvi-client) | `RTVIClientSerializer`: a pipeline acting as an RTVI client of another bot. |
| [`@pipedog/serializer-telnyx`](packages/serializer-telnyx) | `TelnyxFrameSerializer` for Telnyx WebSocket media streams. |
| [`@pipedog/serializer-twilio`](packages/serializer-twilio) | `TwilioFrameSerializer` for Twilio Media Streams, with hang-up through Twilio's REST API. |
| [`@pipedog/serializer-plivo`](packages/serializer-plivo) | `PlivoFrameSerializer` for Plivo audio streaming. |
| [`@pipedog/serializer-exotel`](packages/serializer-exotel) | `ExotelFrameSerializer` for Exotel's Voicebot media streams. |
| [`@pipedog/serializer-vonage`](packages/serializer-vonage) | `VonageFrameSerializer` for the Vonage Audio Connector. |
| [`@pipedog/serializer-genesys`](packages/serializer-genesys) | `GenesysAudioHookSerializer` for Genesys Cloud AudioHook. |
| [`@pipedog/runner`](packages/runner) | Pipecat's development runner: `createTransport()` from the runner arguments, and `main()`, a dev server with the prebuilt browser client, SmallWebRTC signalling, LiveKit session tokens, and telephony webhooks and WebSockets for Twilio, Telnyx, Plivo and Exotel. Also a fetch handler (`createRunnerApp()`) to mount in your own server. |
| [`@pipedog/evals`](packages/evals) | Pipecat's evals: test a bot end to end with scripted or LLM-simulated users, matchers and an LLM judge, from YAML scenarios, with the `pipedog-eval` CLI and multi-bot suites. |
| [`@pipedog/audio-silero`](packages/audio-silero) | Silero VAD (`SileroVADAnalyzer`), with the upstream model included. |
| [`@pipedog/audio-smart-turn`](packages/audio-smart-turn) | Smart Turn end-of-turn detection: local v3 with the upstream model included, and `HttpSmartTurnAnalyzer` for a remote endpoint (`fetch` only). |
| [`@pipedog/audio-rnnoise-filter`](packages/audio-rnnoise-filter) | `RNNoiseFilter`: RNNoise noise suppression compiled to WebAssembly, on every runtime. |
| [`@pipedog/audio-soundfile-mixer`](packages/audio-soundfile-mixer) | `SoundfileMixer`: background sound from WAV files (bytes, URL or path) mixed into the bot's audio, in pure TypeScript. |
| [`@pipedog/onnx`](packages/onnx) | Small ONNX inference backend: `onnxruntime-node` when installed, else `onnxruntime-web`, with a Workers variant. |
| [`@pipedog/resampler-wasm`](packages/resampler-wasm) | High-quality PCM resampling (rubato sinc, compiled to WebAssembly), one-shot and streaming. |
| [`@pipedog/sentencex-wasm`](packages/sentencex-wasm) | Wikimedia sentencex sentence segmentation, compiled to WebAssembly. |
| [`@pipedog/tracing`](packages/tracing) | OpenTelemetry setup (`setupTracing()`) with OTLP/HTTP and console exporters. |
| [`@pipedog/mcp`](packages/mcp) | A local MCP server with these docs and the API of every package, for coding agents: `claude mcp add pipedog -- npx -y @pipedog/mcp`. |

Where Python installs `pipecat-ai[deepgram,openai]`, you add `@pipedog/core`, `@pipedog/deepgram`
and `@pipedog/openai`. Modules are imported by their upstream path:
`from pipecat.pipeline.worker import PipelineWorker` becomes
`import { PipelineWorker } from "@pipedog/core/pipeline/worker"`.

## Examples

| Example | What |
| --- | --- |
| [`smallwebrtc-voice-bot`](examples/smallwebrtc-voice-bot) | Voice assistant in the browser over SmallWebRTC, with OpenAI or Google Gemini services. Tested end to end in headless Chromium. |
| [`websocket-voice-bot`](examples/websocket-voice-bot) | The same voice assistant over a WebSocket with protobuf frames, the format `@pipecat-ai/websocket-transport` speaks. Tested end to end in headless Chromium. |
| [`twilio-phone-bot`](examples/twilio-phone-bot) | A phone bot on Twilio Media Streams, the TwiML webhook and the media WebSocket as one fetch handler (Bun or Node with `serveFetch`, Deno, Workers). Tested with a scripted fake Twilio, in process and on Deno. |
| [`workers-durable-voice-agent`](examples/workers-durable-voice-agent) | Parallel voice agents on Cloudflare Workers, one Durable Object per session, over WebSocket. Tested end to end against workerd with parallel sessions. |
| [`framework-snippets`](examples/framework-snippets) | The same voice endpoints mounted in Bun, Deno, Elysia, Express, Hono, Next.js, Nuxt, SvelteKit, TanStack Start and Vercel. |
| [`test-mocks`](examples/test-mocks) | Mock OpenAI and Gemini APIs and a recorded question, used by the examples' tests. |

## Documentation

- [Getting started](https://polvallverdu.github.io/pipedog/docs/) and
  [installation](https://polvallverdu.github.io/pipedog/docs/installation/)
- [Voice bot over SmallWebRTC](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
- [Development runner](https://polvallverdu.github.io/pipedog/docs/runner/): `main()`, the
  prebuilt client and phone calls, as in Pipecat's runner
- [Evals](https://polvallverdu.github.io/pipedog/docs/evals/): test a bot end to end with scripted
  or simulated users and an LLM judge (`pipedog-eval`)
- [Telephony](https://polvallverdu.github.io/pipedog/docs/telephony/): Twilio, Telnyx, Plivo,
  Exotel, Vonage and Genesys
- [Examples](https://polvallverdu.github.io/pipedog/docs/examples/): every runnable example and its run command
- [Turn detection](https://polvallverdu.github.io/pipedog/docs/turn-detection/): local models, VAD
  only, or on the provider's side
- [Voice agents on Workers and Durable Objects](https://polvallverdu.github.io/pipedog/docs/workers/)
- [Frameworks](https://polvallverdu.github.io/pipedog/docs/frameworks/): Express, Hono, Next.js and more
- [Coming from Pipecat (Python)](https://polvallverdu.github.io/pipedog/docs/coming-from-pipecat/)
- [Runtimes & compatibility](https://polvallverdu.github.io/pipedog/docs/runtimes/)
- [Docs for AI tools](https://polvallverdu.github.io/pipedog/docs/guides/llms/): llms.txt, Markdown pages
  and the [`@pipedog/mcp`](packages/mcp) server for coding agents

## Status

pipedog is 0.x: expect breaking changes between minor versions. Against the pinned upstream
commit, 559 of Pipecat's 667 modules are ported (84%, 75% of the lines) and 272 of its 340 test
files.

- **Core runtime: complete.** All 361 core modules are ported, and all 150 of core's upstream test
  files are ported 1:1 and passing.
- **Providers: the main ones.** Across 58 packages: OpenAI, Anthropic, Google, Azure, AWS (with Nova
  Sonic), Deepgram, Cartesia, ElevenLabs, Inworld, Ultravox, 16 OpenAI-compatible providers (Groq,
  Together, Mistral, xAI, DeepSeek, OpenRouter, Ollama and more), HeyGen avatars, the WebSocket,
  SmallWebRTC, LiveKit, WhatsApp and local audio transports, six telephony serializers, the
  development runner, Pipecat Flows, evals, and the RNNoise filter, soundfile mixer and HTTP Smart
  Turn.
- **Not ported yet:** the Daily and other room transports (Tavus, LemonSlice, MoQ, the Vonage Video
  Connector), the Krisp, Koala and AIC filters and models, most of the CLI (`pipecat init`
  scaffolding, the service registry, hub status and the config validator; the eval command exists
  as `pipedog-eval`), the MCP client service, and 33 other providers (AssemblyAI, Gladia,
  Speechmatics, Rime, NVIDIA and a long tail). See the
  [roadmap](https://polvallverdu.github.io/pipedog/docs/roadmap/).
- **Testing: mocks and recordings, not live providers yet.** Every provider is tested against mock
  servers and recorded protocol vectors, and the examples run end to end against mock APIs.
  Tests that need real API keys are skipped by default, as upstream does, so live providers are
  only lightly exercised. Testing against the real providers is the next phase. Bug reports from
  real use are very welcome.

Per-package progress, test counts and verified runtimes: [`porting/STATUS.md`](porting/STATUS.md)
(also [on the docs site](https://polvallverdu.github.io/pipedog/docs/contributing/status/)).

## Relation to upstream

pipedog tracks one pinned Pipecat commit at a time.

- [`upstream.json`](upstream.json) pins the upstream repository and commit. `bun run upstream`
  checks it out into `.upstream/pipecat`, and `bun run upstream bump` moves the pin.
- [`porting/manifest.json`](porting/manifest.json) lists every upstream module (667) and test file
  (340) with its target package (105 in all, 53 of them ported at least in part), TypeScript path,
  dependencies and status. [`porting/STATUS.md`](porting/STATUS.md) is generated from it.
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) is the rulebook for how Python maps to TypeScript.
  Deliberate differences from upstream are marked `DIVERGENCE` in the code and listed in the manifest.

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

BSD 2-Clause, like upstream. Copyright (c) 2024–2026 Daily for the original Pipecat code, and
pipedog contributors for the port. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
