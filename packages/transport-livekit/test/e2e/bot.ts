// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The bot side of the LiveKit end-to-end test (see ../e2e.test.ts), runnable
// on Bun, Node and Deno: joins a LiveKit room with LiveKitTransport and runs a
// tiny pipeline: input -> loopback (the user's audio is played back) ->
// output, with the worker's RTVIProcessor answering "echo" client messages.
//
//   <runtime> bot.ts   (env: LIVEKIT_URL, LIVEKIT_TOKEN, LIVEKIT_ROOM)
//
// Prints "SUMMARY <json>" and exits once the user leaves.

import { type Frame, InputAudioRawFrame, OutputAudioRawFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { type FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { RTVIProcessor } from "@pipedog/core/processors/frameworks/rtvi/index";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { LiveKitParams, LiveKitTransport } from "@pipedog/transport-livekit/transport";

const SAMPLE_RATE = 16000;
const g = globalThis as any;
const env = (name: string): string | undefined =>
  g.Deno ? g.Deno.env.get(name) : g.process.env[name];
const runtime = g.Bun
  ? `bun ${g.Bun.version}`
  : g.Deno
    ? `deno ${g.Deno.version.deno}`
    : `node ${g.process.version}`;

const stats = {
  runtime,
  connected: 0,
  participants: [] as string[],
  audioFrames: 0,
  loudFrames: 0,
  userIds: [] as string[],
  clientReady: 0,
  echoes: 0,
};

/** Plays the user's audio back, and counts what it hears. */
class LoopbackProcessor extends FrameProcessor {
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof InputAudioRawFrame) {
      stats.audioFrames++;
      const userId = (frame as { userId?: string }).userId;
      if (userId && !stats.userIds.includes(userId)) stats.userIds.push(userId);
      const pcm = new Int16Array(frame.audio.slice().buffer);
      let sum = 0;
      for (const s of pcm) sum += s * s;
      if (Math.sqrt(sum / Math.max(1, pcm.length)) > 1500) stats.loudFrames++;
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

const transport = new LiveKitTransport({
  url: env("LIVEKIT_URL")!,
  token: env("LIVEKIT_TOKEN")!,
  roomName: env("LIVEKIT_ROOM")!,
  params: new LiveKitParams({ audioInEnabled: true, audioOutEnabled: true }),
});
const worker = new PipelineWorker(
  new Pipeline([transport.input(), new LoopbackProcessor(), transport.output()]),
  {
    cancelOnIdleTimeout: false,
    params: new PipelineParams({ audioInSampleRate: SAMPLE_RATE, audioOutSampleRate: SAMPLE_RATE }),
  },
);
worker.rtvi.eventHandler("on_client_ready", async () => {
  stats.clientReady++;
});
worker.rtvi.eventHandler(
  "on_client_message",
  async (rtvi: RTVIProcessor, msg: { type: string; data: { n: number } }) => {
    if (msg.type === "echo") {
      stats.echoes++;
      await rtvi.sendServerMessage({ kind: "echo", n: msg.data.n });
    }
  },
);
transport.eventHandler("on_connected", async () => {
  stats.connected++;
  console.log("CONNECTED");
});
transport.eventHandler("on_participant_connected", async (_t: unknown, id: string) => {
  stats.participants.push(id);
});
transport.eventHandler("on_participant_disconnected", async () => {
  await worker.cancel();
});

const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
await runner.addWorkers(worker);
await runner.run();
console.log(`SUMMARY ${JSON.stringify(stats)}`);
// The native SDK keeps handles open; leave once the summary is out.
if (g.Deno) g.Deno.exit(0);
else g.process.exit(0);
