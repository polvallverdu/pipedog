// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// The voice agent, on any transport: speech in, OpenAI transcription, chat and
// speech synthesis, speech out.

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
import type { BaseTransport } from "@pipedog/core/transports/base_transport";
import { TurnAnalyzerUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/turn_analyzer_user_turn_stop_strategy";
import { UserTurnStrategies } from "@pipedog/core/turns/user_turn_strategies";
import { WorkerRunner } from "@pipedog/core/workers/runner";
import { OpenAILLMSettings } from "@pipedog/openai/base_llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAISTTService } from "@pipedog/openai/stt";
import { OpenAITTSService } from "@pipedog/openai/tts";

export const SYSTEM_INSTRUCTION =
  "You are a helpful assistant in a voice conversation. Your responses will be spoken aloud, so avoid emojis, bullet points, or other formatting that can't be spoken. Respond to what the user said in a creative, helpful, and brief way.";

/** Speech in at 16 kHz; OpenAI's speech returns 24 kHz. */
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

/** Runs one voice agent on `transport`, until the client disconnects. Reads OPENAI_API_KEY. */
export async function runAgent(transport: BaseTransport): Promise<void> {
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
    new OpenAISTTService(),
    aggregators.user(),
    new OpenAILLMService({
      settings: new OpenAILLMSettings({ systemInstruction: SYSTEM_INSTRUCTION }),
    }),
    new OpenAITTSService({ sampleRate: OUTPUT_SAMPLE_RATE }),
    transport.output(),
    aggregators.assistant(),
  ]);

  const worker = new PipelineWorker(pipeline, {
    cancelOnIdleTimeout: false,
    params: new PipelineParams({
      audioInSampleRate: INPUT_SAMPLE_RATE,
      audioOutSampleRate: OUTPUT_SAMPLE_RATE,
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
