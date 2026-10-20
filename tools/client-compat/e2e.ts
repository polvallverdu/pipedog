// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// End to end with the official Pipecat browser client, headless: a pipedog
// bot (SingleClientWebsocketServerTransport + ProtobufFrameSerializer + the
// worker's RTVIProcessor) and a real PipecatClient over
// @pipecat-ai/websocket-transport's WebSocketTransport. The client's
// MediaManager (microphone and speaker, which need AudioContext) is replaced
// by a fake that injects mic audio and records the bot's audio; everything
// else (RTVI handshake, protobuf codec, ReconnectingWebSocket) is the
// client's own code.
//
//   bun tools/client-compat/e2e.ts <dir with node_modules/@pipecat-ai/{websocket-transport,client-js}>
//
// Install the client in a scratch directory first:
//
//   npm install --ignore-scripts @pipecat-ai/websocket-transport@1.7.2 @pipecat-ai/client-js@1.13.1
//
// Checks: connect resolves on the bot's bot-ready; mic audio reaches the bot
// and comes back (the bot echoes it) bit-exact; a client request gets the
// bot's server-response; a server-message reaches onServerMessage.

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTask, sleep, waitFor } from "../../packages/asyncio/src/index.ts";
import {
  EndFrame,
  type Frame,
  InputAudioRawFrame,
  OutputAudioRawFrame,
} from "../../packages/core/src/frames/frames.ts";
import { Pipeline } from "../../packages/core/src/pipeline/pipeline.ts";
import { PipelineParams, PipelineWorker } from "../../packages/core/src/pipeline/worker.ts";
import {
  type FrameDirection,
  FrameProcessor,
} from "../../packages/core/src/processors/frame_processor.ts";
import type { RTVIProcessor } from "../../packages/core/src/processors/frameworks/rtvi/index.ts";
import { WorkerRunner } from "../../packages/core/src/workers/runner.ts";
import { ProtobufFrameSerializer } from "../../packages/serializer-protobuf/src/protobuf.ts";
import {
  SingleClientWebsocketServerParams,
  SingleClientWebsocketServerTransport,
} from "../../packages/transport-websocket/src/server.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun tools/client-compat/e2e.ts <client install dir>");
  process.exit(2);
}
const root = resolve(dir);
const importFrom = (name: string) =>
  import(pathToFileURL(join(root, "node_modules", name, "dist", "index.module.js")).href);
const wt = await importFrom("@pipecat-ai/websocket-transport");
const cj = await importFrom("@pipecat-ai/client-js");

const SAMPLE_RATE = 16000;

/** Sends every input audio frame back as output audio. */
class EchoProcessor extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InputAudioRawFrame) {
      await this.pushFrame(
        new OutputAudioRawFrame({
          audio: frame.audio,
          sampleRate: frame.sampleRate,
          numChannels: frame.numChannels,
        }),
      );
    } else {
      await this.pushFrame(frame, direction);
    }
  }
}

/** The client's MediaManager, minus devices. */
class FakeMediaManager {
  userAudioCallback: ((data: ArrayBuffer) => void) | null = null;
  botAudio: number[] = [];
  setUserAudioCallback(cb: (data: ArrayBuffer) => void) {
    this.userAudioCallback = cb;
  }
  setClientOptions() {}
  async initialize() {}
  async connect() {}
  async disconnect() {}
  async userStartedSpeaking() {}
  bufferBotAudio(data: Int16Array) {
    this.botAudio.push(...data);
    return data;
  }
  async getAllMics() {
    return [];
  }
  async getAllCams() {
    return [];
  }
  async getAllSpeakers() {
    return [];
  }
  updateMic() {}
  updateCam() {}
  updateSpeaker() {}
  get selectedMic() {
    return {};
  }
  get selectedCam() {
    return {};
  }
  get selectedSpeaker() {
    return {};
  }
  enableMic() {}
  enableCam() {}
  enableScreenShare() {}
  get isCamEnabled() {
    return false;
  }
  get isMicEnabled() {
    return true;
  }
  get isSharingScreen() {
    return false;
  }
  tracks() {
    return { local: { audio: undefined, video: undefined } };
  }
}

function check(ok: boolean, what: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
}

const freePort = (): number => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = s.port as number;
  s.stop(true);
  return port;
};
const port = freePort();

// --- bot ---------------------------------------------------------------------

const transport = new SingleClientWebsocketServerTransport(
  new SingleClientWebsocketServerParams({
    serializer: new ProtobufFrameSerializer(),
    audioInEnabled: true,
    audioOutEnabled: true,
  }),
  { host: "127.0.0.1", port },
);
const worker = new PipelineWorker(
  new Pipeline([transport.input(), new EchoProcessor(), transport.output()]),
  {
    cancelOnIdleTimeout: false,
    params: new PipelineParams({ audioInSampleRate: SAMPLE_RATE, audioOutSampleRate: SAMPLE_RATE }),
  },
);
const clientMessages: unknown[] = [];
worker.rtvi.eventHandler("on_client_message", async (rtvi: RTVIProcessor, msg: any) => {
  clientMessages.push({ type: msg.type, data: msg.data });
  await rtvi.sendServerResponse(msg, { echoed: msg.data, note: "ünï 🐶" });
});
const runner = new WorkerRunner({ handleSigint: false });
await runner.addWorkers(worker);
const runTask = createTask(() => runner.run());
await sleep(0.3);

// --- client ------------------------------------------------------------------

// PipecatClient reads `window.navigator` to describe itself in client-ready.
(globalThis as any).window ??= globalThis;
// Bun's WebSocket defaults to binaryType "nodebuffer"; the client expects the
// browser default ("blob") and silently drops anything else.
if ((globalThis as any).Bun) {
  const BunWebSocket = globalThis.WebSocket;
  (globalThis as any).WebSocket = class extends BunWebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.binaryType = "blob";
    }
  };
}

const media = new FakeMediaManager();
const serverMessages: unknown[] = [];
let botReady: unknown = null;
const client = new cj.PipecatClient({
  transport: new wt.WebSocketTransport({ mediaManager: media }),
  enableMic: true,
  enableCam: false,
  callbacks: {
    onBotReady: (data: unknown) => {
      botReady = data;
    },
    onServerMessage: (data: unknown) => serverMessages.push(data),
  },
});
cj.setLogLevel?.(cj.LogLevel.WARN);

await waitFor(() => client.connect({ wsUrl: `ws://127.0.0.1:${port}` }), 10);
check(botReady !== null, `connect() resolved on bot-ready: ${JSON.stringify(botReady)}`);

// Mic audio: 0.32 s at 16 kHz in the client's 512-sample recorder chunks (a whole
// number of the output transport's 40 ms chunks, so none is held back).
const mic = Int16Array.from({ length: 5120 }, (_, i) => ((i * 97) % 65536) - 32768);
for (let i = 0; i < mic.length; i += 512) {
  media.userAudioCallback?.(mic.slice(i, i + 512).buffer);
}

const reply = await waitFor(
  () => client.sendClientRequest("ping", { n: 1.5, s: "héllo" }, 5000),
  10,
);
check(
  JSON.stringify(reply) === JSON.stringify({ echoed: { n: 1.5, s: "héllo" }, note: "ünï 🐶" }),
  `client request answered by server-response: ${JSON.stringify(reply)}`,
);
check(clientMessages.length === 1, `bot saw the client-message: ${JSON.stringify(clientMessages)}`);

await worker.rtvi.sendServerMessage({ hello: "wörld", x: [1, 2.5] });

for (let i = 0; i < 50 && media.botAudio.length < mic.length; i++) await sleep(0.1);
const echoed = media.botAudio.slice(0, mic.length);
check(
  echoed.length === mic.length && echoed.every((v, i) => v === mic[i]),
  `mic audio echoed bit-exact (${mic.length} samples sent, ${media.botAudio.length} received)`,
);
for (let i = 0; i < 20 && serverMessages.length === 0; i++) await sleep(0.05);
check(
  JSON.stringify(serverMessages) === JSON.stringify([{ hello: "wörld", x: [1, 2.5] }]),
  `server-message delivered: ${JSON.stringify(serverMessages)}`,
);

await client.disconnect();
await worker.queueFrame(new EndFrame());
await waitFor(() => runTask, 10);
console.log(process.exitCode ? "FAILED" : "all checks passed");
process.exit(process.exitCode ?? 0);
