// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/deployment/cloudflare-workers-ai.mdx: a voice agent
// whose speech-to-text, LLM and text-to-speech all run on Workers AI. Type-checked
// on every docs build.

// #region env
import type { WorkersAIBinding } from "@pipedog/cloudflare/client";

export interface Env {
  /** The Workers AI binding: `"ai": { "binding": "AI" }` in wrangler.jsonc. */
  AI: WorkersAIBinding;
  /** For the LLM, which uses Workers AI's OpenAI-compatible REST endpoint. */
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
}

// #endregion env

// #region agent
import { WorkersAIFluxSTTService } from "@pipedog/cloudflare/flux_stt";
import { WorkersAILLMService } from "@pipedog/cloudflare/llm";
import { WorkersAIAuraTTSService } from "@pipedog/cloudflare/tts";
import { LLMRunFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";

/** Flux and the client both use 16 kHz audio; Aura answers at 24 kHz. */
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

export async function runVoiceAgent(connection: WebsocketConnection, env: Env): Promise<void> {
  const transport = new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      serializer: new ProtobufFrameSerializer(),
    }),
  );

  // Flux detects the start and end of each turn, so there is no VAD analyzer
  // and no Smart Turn model to load: the user aggregator follows Flux.
  const stt = new WorkersAIFluxSTTService({ ai: env.AI });

  const llm = new WorkersAILLMService({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    settings: new WorkersAILLMService.Settings({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      systemInstruction:
        "You are a helpful assistant in a voice conversation. Answer briefly, in plain sentences.",
    }),
  });

  const tts = new WorkersAIAuraTTSService({
    ai: env.AI,
    sampleRate: OUTPUT_SAMPLE_RATE,
    settings: new WorkersAIAuraTTSService.Settings({ voice: "luna" }),
  });

  const context = new LLMContext();
  const aggregators = new LLMContextAggregatorPair(context);

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
    cancelOnIdleTimeout: false,
    params: new PipelineParams({
      audioInSampleRate: INPUT_SAMPLE_RATE,
      audioOutSampleRate: OUTPUT_SAMPLE_RATE,
      enableMetrics: true,
      enableUsageMetrics: true,
    }),
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
// #endregion agent
