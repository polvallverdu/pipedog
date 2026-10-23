// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The pipedog side of the pacing benchmark (tools/bench/pacing.ts): a bot that plays two
// utterances through the WebSocket server transport and the Telnyx serializer, as a telephony
// bot does. The same scenario is in bot.py, against upstream Pipecat.
//
// Environment: PACING_PORT, PACING_LOAD (0..1: share of the event loop kept busy by other work).

import { createTask, sleep } from "@pipedog/asyncio";
import { EndFrame, TTSAudioRawFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { logger } from "@pipedog/core/utils/logger";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import {
  TelnyxFrameSerializer,
  TelnyxFrameSerializerInputParams,
} from "@pipedog/serializer-telnyx";
import {
  SingleClientWebsocketServerParams,
  SingleClientWebsocketServerTransport,
} from "@pipedog/transport-websocket/server";

logger.setLevel("WARNING");

const g = globalThis as any;
const env = (k: string) => (g.Deno ? g.Deno.env.get(k) : g.process.env[k]) ?? "";
const PORT = Number(env("PACING_PORT") || 8765);
const LOAD = Number(env("PACING_LOAD") || 0);

const RATE = 24000;
const FRAME_MS = 40;
const UTTERANCE_SECS = 6;
const PAUSE_SECS = 3;

/** Speech-like test audio: a few tones with a syllable-rate envelope, at 24 kHz. */
function utterance(): TTSAudioRawFrame[] {
  const perFrame = (RATE * FRAME_MS) / 1000;
  const frames: TTSAudioRawFrame[] = [];
  let n = 0;
  for (let f = 0; f < (UTTERANCE_SECS * 1000) / FRAME_MS; f++) {
    const pcm = new Int16Array(perFrame);
    for (let i = 0; i < perFrame; i++, n++) {
      const t = n / RATE;
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
      const s =
        0.2 * Math.sin(2 * Math.PI * 220 * t) +
        0.12 * Math.sin(2 * Math.PI * 660 * t) +
        0.06 * Math.sin(2 * Math.PI * 1800 * t);
      pcm[i] = Math.round(env * s * 32767);
    }
    frames.push(
      new TTSAudioRawFrame({ audio: new Uint8Array(pcm.buffer), sampleRate: RATE, numChannels: 1 }),
    );
  }
  return frames;
}

/** Other work sharing the event loop: busy for LOAD of every 10 ms. */
async function backgroundLoad(): Promise<void> {
  if (LOAD <= 0) return;
  for (;;) {
    const end = performance.now() + 10 * LOAD;
    while (performance.now() < end) {
      // busy
    }
    await sleep(0.01 * (1 - LOAD));
  }
}

const transport = new SingleClientWebsocketServerTransport(
  new SingleClientWebsocketServerParams({
    audioOutEnabled: true,
    serializer: new TelnyxFrameSerializer({
      streamId: "pacing-stream",
      outboundEncoding: "PCMU",
      inboundEncoding: "PCMU",
      params: new TelnyxFrameSerializerInputParams({ autoHangUp: false }),
    }),
  }),
  { host: "127.0.0.1", port: PORT },
);

// The pipeline's output rate defaults to 24 kHz (RATE), as upstream's does.
const worker = new PipelineWorker(new Pipeline([transport.input(), transport.output()]), {
  cancelOnIdleTimeout: false,
});

transport.eventHandler("on_client_connected", async () => {
  createTask(async () => {
    const load = createTask(backgroundLoad);
    await worker.queueFrames(utterance());
    await sleep(UTTERANCE_SECS + PAUSE_SECS);
    await worker.queueFrames(utterance());
    await sleep(UTTERANCE_SECS + PAUSE_SECS);
    load.cancel();
    await worker.queueFrame(new EndFrame());
  });
});

const runner = new WorkerRunner({ handleSigint: false });
await runner.addWorkers(worker);
console.log("__PACING_READY__");
await runner.run();
g.Deno ? g.Deno.exit(0) : g.process.exit(0);
