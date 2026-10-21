// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// One voice agent over a WebSocket: audio in as protobuf frames, OpenAI
// realtime transcription, chat and speech synthesis, audio out.
//
// Turn detection runs on OpenAI's side (server VAD), so the Worker loads no
// local models: no Silero VAD, no Smart Turn, no ONNX runtime. That keeps the
// Worker small enough to deploy and light on memory; see the README for the
// numbers, and for running the local models elsewhere.

import { LLMRunFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAIRealtimeSTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";
import { ProtobufFrameSerializer } from "@pipedog/serializer-protobuf/protobuf";
import {
  FastAPIWebsocketParams,
  FastAPIWebsocketTransport,
} from "@pipedog/transport-websocket/fastapi";
import type { WebsocketConnection } from "@pipedog/transport-websocket/socket";
import type { Env } from "./worker.ts";

export const SYSTEM_INSTRUCTION =
  "You are a helpful assistant in a voice conversation. Your responses will be spoken aloud, so avoid emojis, bullet points, or other formatting that can't be spoken. Respond to what the user said in a creative, helpful, and brief way.";

/** The client sends 16 kHz audio; OpenAI's speech returns 24 kHz. */
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

/** Runs one voice agent over `connection` until the client disconnects. */
export async function runVoiceAgent(connection: WebsocketConnection, env: Env): Promise<void> {
  const apiKey = env.OPENAI_API_KEY;
  const baseUrl = env.OPENAI_BASE_URL ?? null;

  const transport = new FastAPIWebsocketTransport(
    connection,
    new FastAPIWebsocketParams({
      audioInEnabled: true,
      audioOutEnabled: true,
      serializer: new ProtobufFrameSerializer(),
    }),
  );

  // OpenAI detects when the user starts and stops speaking. With no VAD
  // analyzer, the user aggregator follows the service's turn signals.
  const stt = new OpenAIRealtimeSTTService({
    apiKey,
    baseUrl: env.OPENAI_REALTIME_URL,
    turnDetection: { type: "server_vad" },
  });

  const context = new LLMContext();
  const aggregators = new LLMContextAggregatorPair(context);

  const pipeline = new Pipeline([
    transport.input(),
    stt,
    aggregators.user(),
    new OpenAILLMService({
      apiKey,
      baseUrl,
      settings: new OpenAILLMSettings({ systemInstruction: SYSTEM_INSTRUCTION }),
    }),
    new OpenAITTSService({ apiKey, baseUrl, sampleRate: OUTPUT_SAMPLE_RATE }),
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
    context.addMessage({
      role: "developer",
      content: "Please introduce yourself to the user.",
    });
    await worker.queueFrames([new LLMRunFrame()]);
  });
  transport.eventHandler("on_client_disconnected", async () => {
    await runner.cancel();
  });

  await runner.run();
}
