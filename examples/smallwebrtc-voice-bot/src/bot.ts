// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// A voice assistant over SmallWebRTC: the user's speech goes to OpenAI
// (transcription, chat and speech synthesis) and the reply is spoken back.
// Mirrors Pipecat's examples/transports/transports-small-webrtc.py, with
// OpenAI in place of Deepgram and Cartesia.

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
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { TurnAnalyzerUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/turn_analyzer_user_turn_stop_strategy";
import { UserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { SmallWebRTCTransport } from "@pipedog/transport-smallwebrtc/transport";

export const SYSTEM_INSTRUCTION =
  "You are a helpful assistant in a voice conversation. Your responses will be spoken aloud, so avoid emojis, bullet points, or other formatting that can't be spoken. Respond to what the user said in a creative, helpful, and brief way.";

/** Input audio from the browser is 16 kHz. */
const INPUT_SAMPLE_RATE = 16000;
/** OpenAI's speech synthesis returns 24 kHz PCM. */
const OUTPUT_SAMPLE_RATE = 24000;

export interface VoiceBotOptions {
  /** OpenAI API key. Defaults to the `OPENAI_API_KEY` environment variable. */
  apiKey?: string;
  /** Base URL of an OpenAI-compatible API. Defaults to `OPENAI_BASE_URL`, then the OpenAI API. */
  baseUrl?: string;
}

/** Runs one voice conversation over `connection`, until the client disconnects. */
export async function runVoiceBot(
  connection: SmallWebRTCConnection,
  options: VoiceBotOptions = {},
): Promise<void> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? null;
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? null;

  const transport = new SmallWebRTCTransport(
    connection,
    new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  );

  const stt = new OpenAISTTService({ apiKey, baseUrl });
  const llm = new OpenAILLMService({
    apiKey,
    baseUrl,
    settings: new OpenAILLMSettings({ systemInstruction: SYSTEM_INSTRUCTION }),
  });
  const tts = new OpenAITTSService({ apiKey, baseUrl, sampleRate: OUTPUT_SAMPLE_RATE });

  const context = new LLMContext();
  const aggregators = new LLMContextAggregatorPair(context, {
    userParams: new LLMUserAggregatorParams({
      vadAnalyzer: new SileroVADAnalyzer(),
      userTurnStrategies: new UserTurnStrategies({
        stop: [
          new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: createLocalSmartTurnAnalyzerV3() }),
        ],
      }),
    }),
  });

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
    // Kick off the conversation.
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
