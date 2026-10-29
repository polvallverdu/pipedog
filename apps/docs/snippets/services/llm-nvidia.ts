// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/nvidia.mdx. Type-checked on every docs build.

// #region usage
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { CartesiaTTSService } from "@pipedog/cartesia/tts";
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
  type UserTurnMessageAddedMessage,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import type { BaseTransport } from "@pipedog/core/transports/base_transport";
import { NvidiaLLMService } from "@pipedog/nvidia/llm";
import { NvidiaOmniLLMService } from "@pipedog/nvidia/omni/llm";

const llm = new NvidiaLLMService({
  apiKey: process.env.NVIDIA_API_KEY ?? "",
  settings: new NvidiaLLMService.Settings({
    model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    systemInstruction: "You are a helpful assistant in a voice conversation. Keep replies short.",
  }),
});
// #endregion usage

// #region local
// A NIM running on your own machine takes no API key.
const local = new NvidiaLLMService({ baseUrl: "http://localhost:8000/v1" });
// #endregion local

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new NvidiaLLMService.Settings({ temperature: 0.4 }),
});
// #endregion update

declare const transport: BaseTransport;

// #region omni
// Omni hears the user's speech itself, so there is no STT service.
const omni = new NvidiaOmniLLMService({
  apiKey: process.env.NVIDIA_API_KEY ?? "",
  settings: new NvidiaOmniLLMService.Settings({
    systemInstruction: "You are a helpful assistant in a voice conversation. Keep replies short.",
  }),
});
const tts = new CartesiaTTSService({ apiKey: process.env.CARTESIA_API_KEY ?? "" });

const context = new LLMContext();
const aggregators = new LLMContextAggregatorPair(context, {
  userParams: new LLMUserAggregatorParams({ vadAnalyzer: new SileroVADAnalyzer() }),
});
const userAggregator = aggregators.user();

const pipeline = new Pipeline([
  transport.input(),
  userAggregator,
  omni, // hears the user and answers
  tts,
  transport.output(),
  aggregators.assistant(),
]);

// What the user said is known once Omni has transcribed it.
userAggregator.eventHandler(
  "on_user_turn_message_added",
  async (_aggregator, message: UserTurnMessageAddedMessage) => {
    console.log("user said:", message.content);
  },
);
// #endregion omni

// #region cascade
// With an STT service in the pipeline, Omni is a text LLM that also reads media in the context.
const textOmni = new NvidiaOmniLLMService({
  apiKey: process.env.NVIDIA_API_KEY ?? "",
  audioInput: false,
});
// #endregion cascade

// #region multimodal
// Analyze a video outside the pipeline, with a cap on the reasoning.
async function describeVideo(base64Mp4: string): Promise<string> {
  const media = new LLMContext({
    messages: [
      await LLMContext.createFileMessage({
        type: "bytes",
        format: "video/mp4",
        file: `data:video/mp4;base64,${base64Mp4}`,
        text: "Describe what happens in this clip.",
      }),
    ],
  });
  const result = await textOmni.runMultimodalInference(media, {
    reasoningBudget: 512,
    maxTokens: 1024,
  });
  return result.text;
}
// #endregion multimodal
