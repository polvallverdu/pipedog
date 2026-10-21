// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The bot the runner's end-to-end tests run: written as a migrated Pipecat
// bot.py would be, with createTransport picking WebRTC or Telnyx from the
// runner arguments. It greets the caller through OpenAI's speech synthesis,
// which the tests point at a mock (OPENAI_BASE_URL). Each session's outcome is
// recorded in `outcomes`, also served at GET /test/outcomes when this file runs
// as a script (`bun bot.ts -t telnyx`), through the module-level `app`.

import { TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { FastAPIWebsocketParams } from "@pipedog/transport-websocket/fastapi";
// Imported by path: a workspace devDependency would end up in the published manifest.
import { OpenAITTSService } from "../../../openai/src/tts.ts";

import { app, main } from "../../src/run.ts";
import { type RunnerArguments, WebSocketRunnerArguments } from "../../src/types.ts";
import { createTransport, TelephonyCallEndedError } from "../../src/utils.ts";

export const GREETING_TEXT = "Hello from the runner.";

export interface Outcome {
  kind: string;
  transportType?: string | null;
  callId?: string | null;
  streamId?: string | null;
  handshake?: unknown;
  error?: string;
}

export const outcomes: Outcome[] = [];

app.get("/test/outcomes", () => outcomes);

const transportParams = {
  webrtc: () => new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  telnyx: () => new FastAPIWebsocketParams({ audioInEnabled: true, audioOutEnabled: true }),
};

export async function bot(runnerArgs: RunnerArguments): Promise<void> {
  let transport: Awaited<ReturnType<typeof createTransport>>;
  try {
    transport = await createTransport(runnerArgs, transportParams);
  } catch (e) {
    if (e instanceof TelephonyCallEndedError) {
      outcomes.push({
        kind: "hung-up",
        handshake: (runnerArgs as WebSocketRunnerArguments).handshake,
        error: e.name,
      });
      return;
    }
    outcomes.push({ kind: "error", error: String(e) });
    throw e;
  }

  if (runnerArgs instanceof WebSocketRunnerArguments) {
    outcomes.push({
      kind: "call",
      transportType: runnerArgs.transportType,
      callId: runnerArgs.callData?.callId ?? null,
      streamId: runnerArgs.callData?.streamId ?? null,
      handshake: runnerArgs.handshake,
    });
  } else {
    outcomes.push({ kind: "webrtc" });
  }

  const tts = new OpenAITTSService({
    apiKey: "test-key",
    baseUrl: process.env.OPENAI_BASE_URL ?? null,
    sampleRate: 24000,
  });
  const pipeline = new Pipeline([transport.input(), tts, transport.output()]);
  const worker = new PipelineWorker(pipeline, {
    cancelOnIdleTimeout: false,
    params: new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 24000 }),
  });
  const runner = new WorkerRunner({ handleSigint: false, handleSigterm: false });
  await runner.addWorkers(worker);

  transport.eventHandler("on_client_connected", async () => {
    await worker.queueFrames([new TTSSpeakFrame({ text: GREETING_TEXT })]);
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await runner.cancel();
  });

  await runner.run();
}

if (import.meta.main) {
  await main();
}
