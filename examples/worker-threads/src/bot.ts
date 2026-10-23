// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause

/**
 * The bot the server examples run, one per WebSocket connection: Silero VAD,
 * Smart Turn, OpenAI speech-to-text, chat and speech, protobuf audio frames.
 * With a `SmartTurnWorkerPool`, Smart Turn's predictions run on its threads
 * instead of this thread's event loop. Reads OPENAI_API_KEY.
 */

import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { createLocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";
import { LLMRunFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import { TurnAnalyzerUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/index";
import {
  defaultUserTurnStartStrategies,
  UserTurnStrategies,
} from "@pipedog/core/turns/user_turn_strategies";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import type { SmartTurnWorkerPool } from "./smart_turn_pool.ts";

export interface RunBotOptions {
  /** Run Smart Turn's predictions on this pool (default: inline, on this thread). */
  smartTurn?: SmartTurnWorkerPool;
}

/** Runs one bot on `connection` until the client disconnects. */
export async function runBot(
  connection: WebsocketConnection,
  options: RunBotOptions = {},
): Promise<void> {
  const transport = new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      serializer: new ProtobufFrameSerializer(),
    }),
  );
  const turnAnalyzer = options.smartTurn?.analyzer() ?? createLocalSmartTurnAnalyzerV3();
  const context = new LLMContext();
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({
      vadAnalyzer: new SileroVADAnalyzer(),
      userTurnStrategies: new UserTurnStrategies({
        start: defaultUserTurnStartStrategies(),
        stop: [new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer })],
      }),
    }),
  });
  const pipeline = new Pipeline([
    transport.input(),
    new OpenAISTTService(),
    aggregators.user(),
    new OpenAILLMService({
      settings: new OpenAILLMSettings({
        systemInstruction: "You are a helpful voice assistant. Answer briefly, without formatting.",
      }),
    }),
    new OpenAITTSService({ sampleRate: 24000 }),
    transport.output(),
    aggregators.assistant(),
  ]);
  const worker = new PipelineWorker(pipeline, {
    cancelOnIdleTimeout: false,
    params: new PipelineParams({ audioInSampleRate: 16000, audioOutSampleRate: 24000 }),
  });
  // Many calls share this thread: none of them takes the process's signals.
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
