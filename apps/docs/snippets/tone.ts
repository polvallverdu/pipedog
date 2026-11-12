// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/concepts/tone.mdx. Type-checked on every docs build.

// #region pipeline
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { formatPerception } from "@pipedog/core/expressive/perception";
import { ExpressionGuidance, ExpressionPolicy } from "@pipedog/core/expressive/policy";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import {
  LLMContextAggregatorPair,
  LLMUserAggregatorParams,
  type UserTurnStoppedMessage,
} from "@pipedog/core/processors/aggregators/llm_response_universal";
import { PipecatToneReader } from "@pipedog/core/processors/tone/reader/index";
import { PipecatToneTagger } from "@pipedog/core/processors/tone/tagger/index";
import type { BaseTransport } from "@pipedog/core/transports/base_transport";
import type { BaseUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/index";
import { DeepgramSTTService } from "@pipedog/deepgram/stt";
import { ElevenLabsDialogueTTSService } from "@pipedog/elevenlabs/dialogue/tts";
import { OpenAILLMService } from "@pipedog/openai/llm";

declare const transport: BaseTransport;

const stt = new DeepgramSTTService({ apiKey: process.env.DEEPGRAM_API_KEY ?? "" });
// Reads how each user turn was meant. Its model downloads from Hugging Face at start.
const toneReader = new PipecatToneReader();
// Voices the LLM's plain replies, a sentence at a time.
const toneTagger = new PipecatToneTagger();
const llm = new OpenAILLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAILLMService.Settings({
    systemInstruction: "You are a warm assistant in a voice conversation. Keep replies brief.",
  }),
});
// Eleven v3 and v4 perform audio tags.
const tts = new ElevenLabsDialogueTTSService({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  settings: new ElevenLabsDialogueTTSService.Settings({
    voice: process.env.ELEVENLABS_VOICE_ID ?? "",
  }),
});

const context = new LLMContext();
const aggregators = new LLMContextAggregatorPair(context, {
  userParams: new LLMUserAggregatorParams({ vadAnalyzer: new SileroVADAnalyzer() }),
});
const userAggregator = aggregators.user();

const pipeline = new Pipeline([
  transport.input(),
  stt,
  toneReader, // how each user turn was meant
  userAggregator,
  llm,
  toneTagger, // how each sentence is voiced
  tts,
  transport.output(),
  aggregators.assistant(),
]);

const worker = new PipelineWorker(pipeline, {
  params: new PipelineParams({
    enableExpressiveConversation: true,
    expressionPolicy: new ExpressionPolicy({
      guidance: [
        ExpressionGuidance.MATCH_STYLE,
        ExpressionGuidance.SLOW_FOR_DETAILS,
        ExpressionGuidance.BREATHE,
        "If the user sounds angry at 0.7 or above, apologize once, then focus on helping.",
      ],
    }),
  }),
});

userAggregator.eventHandler(
  "on_user_turn_stopped",
  async (_aggregator, _strategy: BaseUserTurnStopStrategy, message: UserTurnStoppedMessage) => {
    if (message.perception) console.log("tone:", formatPerception(message.perception));
  },
);
// #endregion pipeline

// #region options
// A larger tagger, and a reader loaded from a folder of your own instead of Hugging Face.
const largerTagger = new PipecatToneTagger({ size: "32m", threads: 2 });
const localReader = new PipecatToneReader({ modelDir: "/models/tone/reader", precision: "fp32" });
// #endregion options
