// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The bot the evals end-to-end test runs, written as a Pipecat bot.py for the
// development runner would be: createTransport picks the transport from the
// runner arguments, so an eval harness that connects to the runner's /ws and
// sends `eval-connect` gets the eval transport. A voice assistant on OpenAI's
// chat and speech APIs, which the test points at the test-mocks OpenAI mock
// (OPENAI_BASE_URL). It greets the user when the harness connects.

import { LLMRunFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { WorkerRunner } from "@pipedog/core/workers/runner";
// Imported by path: workspace devDependencies would end up in the published manifest.
import { OpenAILLMService } from "../../../openai/src/llm.ts";
import { OpenAITTSService } from "../../../openai/src/tts.ts";
import { main } from "../../../runner/src/run.ts";
import type { RunnerArguments } from "../../../runner/src/types.ts";
import { createTransport } from "../../../runner/src/utils.ts";
import { EvalTransportParams } from "../../src/transport.ts";

const transportParams = {
  eval: () => new EvalTransportParams({ audioInEnabled: true, audioOutEnabled: true }),
};

export async function bot(runnerArgs: RunnerArguments): Promise<void> {
  const transport = await createTransport(runnerArgs, transportParams);

  const baseUrl = process.env.OPENAI_BASE_URL ?? null;
  const llm = new OpenAILLMService({ apiKey: "test-key", baseUrl });
  const tts = new OpenAITTSService({ apiKey: "test-key", baseUrl, sampleRate: 24000 });

  const context = new LLMContext();
  const aggregators = new LLMContextAggregatorPair(context);
  const pipeline = new Pipeline([
    transport.input(),
    aggregators.user(),
    llm,
    tts,
    transport.output(),
    aggregators.assistant(),
  ]);
  const worker = new PipelineWorker(pipeline, {
    cancelOnIdleTimeout: false,
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

if (import.meta.main) {
  await main();
}
