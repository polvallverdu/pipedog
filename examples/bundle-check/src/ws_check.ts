// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Configuration (a): WebSocket transport, OpenAI (against a mock), Silero and Smart
// Turn, and the WASM resampler (the scripted caller resamples the question to 16 kHz
// with it). Run by the ws_*_bot.ts entries, which differ in how they pass the models
// and the ONNX runtime.

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
import { TurnAnalyzerUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/turn_analyzer_user_turn_stop_strategy";
import { UserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { startMockOpenAI } from "@pipedog/example-test-mocks/mock_openai";
import type { OnnxBackend, OnnxModelSource } from "@pipedog/onnx";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import wavPath from "../../test-mocks/assets/capital_question.wav" with { type: "file" };
import { askQuestion, OK_MARKER, serveProtobuf } from "./common.ts";

export interface WsCheckOptions {
  /** Silero's model (default: the file in the package). */
  sileroModel?: OnnxModelSource;
  /**
   * Smart Turn's model (default: the file in the package). With `explicitSmartTurn` off the
   * bot leaves the turn strategies to core, which loads `@pipedog/audio-smart-turn` by name.
   */
  smartTurnModel?: OnnxModelSource;
  explicitSmartTurn?: boolean;
  backend?: Promise<OnnxBackend>;
  /** How long to wait for the answer after the question was sent (default 15). */
  timeoutSecs?: number;
}

export async function checkWebsocketBot(options: WsCheckOptions = {}): Promise<void> {
  const mock = startMockOpenAI();

  async function runBot(connection: WebsocketConnection): Promise<void> {
    const transport = new FastAPIWebsocketTransport(
      connection,
      new FastAPIWebsocketParams({
        audioInEnabled: true,
        audioOutEnabled: true,
        serializer: new ProtobufFrameSerializer(),
      }),
    );
    const apiKey = "test";
    const baseUrl = mock.baseUrl;
    const context = new LLMContext();
    const aggregators = new LLMContextAggregatorPair(context, {
      userParams: new LLMUserAggregatorParams({
        vadAnalyzer: new SileroVADAnalyzer({
          model: options.sileroModel,
          backend: options.backend,
        }),
        userTurnStrategies: options.explicitSmartTurn
          ? new UserTurnStrategies({
              stop: [
                new TurnAnalyzerUserTurnStopStrategy({
                  turnAnalyzer: createLocalSmartTurnAnalyzerV3({
                    model: options.smartTurnModel,
                    backend: options.backend,
                  }),
                }),
              ],
            })
          : undefined,
      }),
    });
    const pipeline = new Pipeline([
      transport.input(),
      new OpenAISTTService({ apiKey, baseUrl }),
      aggregators.user(),
      new OpenAILLMService({ apiKey, baseUrl }),
      new OpenAITTSService({ apiKey, baseUrl, sampleRate: 24000 }),
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
      context.addMessage({ role: "developer", content: "Say hello." });
      await worker.queueFrames([new LLMRunFrame()]);
    });
    transport.eventHandler("on_client_disconnected", async () => {
      await runner.cancel();
    });
    await runner.run();
  }

  const server = serveProtobuf(runBot);
  const wav = new Uint8Array(await Bun.file(new URL(wavPath, import.meta.url)).arrayBuffer());
  // Speech from the bot after the caller started the question: the answer, not the greeting.
  const { audioBytes } = await askQuestion(server.url, wav, 20000, options.timeoutSecs);
  if (!mock.asked.some((q) => q.includes("capital"))) {
    throw new Error(`the question never reached the chat model: ${JSON.stringify(mock.asked)}`);
  }
  console.log(`${OK_MARKER} audioBytes=${audioBytes} asked=${JSON.stringify(mock.asked)}`);
  server.stop();
  mock.stop();
  process.exit(0);
}
