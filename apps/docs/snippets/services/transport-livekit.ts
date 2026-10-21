// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/transports/livekit.mdx. Type-checked on every docs build.

// #region usage
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { configure } from "@pipedog/runner/livekit";
import { LiveKitParams, LiveKitTransport } from "@pipedog/transport-livekit/transport";

// LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_ROOM_NAME (or -r/--room).
// configure() mints an agent token for the bot and logs one for a user.
const [url, token, roomName] = await configure();

const transport = new LiveKitTransport({
  url,
  token,
  roomName,
  params: new LiveKitParams({ audioInEnabled: true, audioOutEnabled: true }),
});

const pipeline = new Pipeline([
  transport.input(),
  // ... STT, LLM context aggregators, LLM, TTS
  transport.output(),
]);
const worker = new PipelineWorker(pipeline);

transport.eventHandler(
  "on_first_participant_joined",
  async (_t: unknown, participantId: string) => {
    console.log(`${participantId} joined`);
  },
);
transport.eventHandler("on_participant_disconnected", async () => {
  await worker.cancel();
});

const runner = new WorkerRunner();
await runner.addWorkers(worker);
await runner.run();

// #endregion usage

// #region runner
import type { RunnerArguments } from "@pipedog/runner";
import { createTransport } from "@pipedog/runner/utils";

/** The bot the development runner starts for each session (`bun bot.ts -t livekit`). */
export async function bot(runnerArgs: RunnerArguments): Promise<void> {
  const transport = await createTransport(runnerArgs, {
    livekit: () => new LiveKitParams({ audioInEnabled: true, audioOutEnabled: true }),
  });
  // ... build the pipeline around transport.input() and transport.output()
  void transport;
}
// #endregion runner
