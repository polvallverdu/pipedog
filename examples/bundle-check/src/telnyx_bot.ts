// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (e): the runner with Telnyx, as a migrated bot.py is written
// (`createTransport`, then a greeting through OpenAI speech against a mock). A
// scripted Telnyx client connects to the runner's `/ws`, completes the
// handshake and waits for the greeting as `media` events.

import { TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { startMockOpenAI } from "@pipedog/example-test-mocks/mock_openai";
import { OpenAITTSService } from "@pipedog/openai/tts";
import { main, RunnerApp } from "@pipedog/runner/run";
import type { RunnerArguments } from "@pipedog/runner/types";
import { createTransport } from "@pipedog/runner/utils";
import { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";
import { OK_MARKER } from "./common.ts";

const mock = startMockOpenAI();
// The Telnyx serializer hangs up through Telnyx's API when the call ends, and wants a key for it.
process.env.TELNYX_API_KEY = "test-telnyx-key";

async function bot(runnerArgs: RunnerArguments): Promise<void> {
  const transport = await createTransport(runnerArgs, {
    telnyx: () => new FastAPIWebsocketParams({ audioInEnabled: true, audioOutEnabled: true }),
  });
  const tts = new OpenAITTSService({ apiKey: "test", baseUrl: mock.baseUrl, sampleRate: 24000 });
  const worker = new PipelineWorker(new Pipeline([transport.input(), tts, transport.output()]), {
    cancelOnIdleTimeout: false,
    params: new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 24000 }),
  });
  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  await runner.addWorkers(worker);
  transport.eventHandler("on_client_connected", async () => {
    await worker.queueFrames([new TTSSpeakFrame({ text: "Hello from the runner." })]);
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await runner.cancel();
  });
  await runner.run();
}

const server = await main({
  argv: ["-t", "telnyx", "--host", "127.0.0.1", "--port", "0"],
  bot,
  app: new RunnerApp(),
  handleSignals: false,
});
if (!server) throw new Error("the runner did not start");

const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
let media = 0;
ws.addEventListener("message", (event) => {
  if (JSON.parse(String(event.data)).event === "media") media++;
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", (e) =>
    reject(new Error(`cannot connect to the runner: ${(e as ErrorEvent).message}`)),
  );
});
ws.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
ws.send(
  JSON.stringify({
    event: "start",
    sequence_number: "1",
    start: {
      user_id: "u-1",
      call_control_id: "v3:cc-123",
      call_session_id: "sess-1",
      from: "+15551234567",
      to: "+15559876543",
      media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
    },
    stream_id: "stream-abc",
  }),
);
const deadline = Date.now() + 20000;
while (media < 10 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
if (media < 10) throw new Error(`the bot sent only ${media} media events`);
console.log(`${OK_MARKER} media=${media}`);
ws.close(1000);
mock.stop();
process.exit(0);
