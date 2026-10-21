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

Every package below is verified on all four, except `@pipedog/transport-smallwebrtc` (not Workers)
and `@pipedog/aws`'s `SageMakerBidiClient` (HTTP/2, not Workers).
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
| [`@pipedog/google`](packages/google) | Google services: Gemini (LLM, Live), Cloud Speech-to-Text, Cloud Text-to-Speech. |
| [`@pipedog/deepgram`](packages/deepgram) | Deepgram services: STT, TTS, Flux STT and TTS. |
| [`@pipedog/cartesia`](packages/cartesia) | Cartesia services: STT, Ink-2 turn-based STT, WebSocket and HTTP TTS. |
| [`@pipedog/elevenlabs`](packages/elevenlabs) | ElevenLabs services: STT, Realtime STT, WebSocket and HTTP TTS. |
| [`@pipedog/inworld`](packages/inworld) | Inworld services: Realtime speech-to-speech, WebSocket and HTTP TTS. |
| [`@pipedog/ultravox`](packages/ultravox) | Ultravox realtime speech-to-speech service. |
| [`@pipedog/aws`](packages/aws) | AWS services: Bedrock LLM, Transcribe STT, Polly TTS, Nova Sonic, AgentCore, and the SageMaker streaming client. |
| [`@pipedog/whisper`](packages/whisper) | Base STT service for Whisper-compatible APIs, shared by the services that speak that protocol. |
| [`@pipedog/langchain`](packages/langchain) | LangChain integration (`LangchainProcessor`). |
| [`@pipedog/transport-smallwebrtc`](packages/transport-smallwebrtc) | Peer-to-peer WebRTC transport (werift, Opus via WASM) for the Pipecat browser SDK's `SmallWebRTCTransport`. |
| [`@pipedog/transport-websocket`](packages/transport-websocket) | WebSocket transports: client, server and bring-your-own-socket, with servers for Bun, Node and Deno, and fetch handlers for Workers. |
| [`@pipedog/serializer-protobuf`](packages/serializer-protobuf) | `ProtobufFrameSerializer`, wire-compatible with Pipecat's `frames.proto`. |
| [`@pipedog/serializer-rtvi-client`](packages/serializer-rtvi-client) | `RTVIClientSerializer`: a pipeline acting as an RTVI client of another bot. |
| [`@pipedog/serializer-telnyx`](packages/serializer-telnyx) | `TelnyxFrameSerializer` for Telnyx WebSocket media streams. |
| [`@pipedog/serializer-twilio`](packages/serializer-twilio) | `TwilioFrameSerializer` for Twilio Media Streams, with hang-up through Twilio's REST API. |
| [`@pipedog/serializer-plivo`](packages/serializer-plivo) | `PlivoFrameSerializer` for Plivo audio streaming. |
| [`@pipedog/serializer-exotel`](packages/serializer-exotel) | `ExotelFrameSerializer` for Exotel's Voicebot media streams. |
| [`@pipedog/serializer-vonage`](packages/serializer-vonage) | `VonageFrameSerializer` for the Vonage Audio Connector. |
| [`@pipedog/serializer-genesys`](packages/serializer-genesys) | `GenesysAudioHookSerializer` for Genesys Cloud AudioHook. |
| [`@pipedog/runner`](packages/runner) | Pipecat's runner, partially: the telephony helpers (`parseTelephonyWebsocket`, `CallData`) that detect the provider and parse a call's handshake. |
| [`@pipedog/audio-silero`](packages/audio-silero) | Silero VAD (`SileroVADAnalyzer`), with the upstream model included. |
| [`@pipedog/audio-smart-turn`](packages/audio-smart-turn) | Local Smart Turn v3 end-of-turn detection, with the upstream model included. |
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
| [`twilio-phone-bot`](examples/twilio-phone-bot) | A phone bot on Twilio Media Streams, the TwiML webhook and the media WebSocket as one fetch handler (Deno, Workers). Tested with a scripted fake Twilio, in process and on Deno. |
| [`workers-durable-voice-agent`](examples/workers-durable-voice-agent) | Parallel voice agents on Cloudflare Workers, one Durable Object per session, over WebSocket. |
| [`framework-snippets`](examples/framework-snippets) | The same voice endpoints mounted in Bun, Deno, Elysia, Express, Hono, Next.js, Nuxt, SvelteKit and Vercel. |
| [`test-mocks`](examples/test-mocks) | Mock OpenAI and Gemini APIs and a recorded question, used by the examples' tests. |

## Documentation

- [Getting started](https://polvallverdu.github.io/pipedog/docs/) and
  [installation](https://polvallverdu.github.io/pipedog/docs/installation/)
- [Voice bot over SmallWebRTC](https://polvallverdu.github.io/pipedog/docs/voice-bot/)
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

pipedog is **early** (0.x). Expect breaking changes between minor versions.

- The core runtime is fully ported, and its upstream test suite is ported 1:1 and passing.
- Only a handful of the upstream providers are ported so far (the packages above). Most of
  Pipecat's services, transports (Daily, LiveKit and others), `flows` and the CLI are not.
- Provider services are tested against mocks and recorded protocol fixtures. Tests that need real API
  keys are skipped by default, as upstream does, so live providers are only lightly tested. Bug
  reports from real use are very welcome.

Per-package progress, test counts and verified runtimes: [`porting/STATUS.md`](porting/STATUS.md)
(also [on the docs site](https://polvallverdu.github.io/pipedog/docs/contributing/status/)).

## Relation to upstream

pipedog tracks one pinned Pipecat commit at a time.

- [`upstream.json`](upstream.json) pins the upstream repository and commit. `bun run upstream`
  checks it out into `.upstream/pipecat`, and `bun run upstream bump` moves the pin.
- [`porting/manifest.json`](porting/manifest.json) lists every upstream module and test with its
  target package, TypeScript path, dependencies and status. [`porting/STATUS.md`](porting/STATUS.md)
  is generated from it.
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) is the rulebook for how Python maps to TypeScript.
  Deliberate differences from upstream are marked `DIVERGENCE` in the code and listed in the manifest.

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

BSD 2-Clause, like upstream. Copyright (c) 2024–2026 Daily for the original Pipecat code, and
pipedog contributors for the port. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
