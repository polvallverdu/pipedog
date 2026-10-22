// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/telephony/extensions.mdx. Type-checked on every docs build.

import { CartesiaTTSService } from "@pipedog/cartesia/tts";
import { VADParams } from "@pipedog/core/audio/vad/vad_analyzer";
import { JevClassifier } from "@pipedog/core/classifiers/typesafe/jev/classifier";
import { EndWorkerFrame, LLMMessagesUpdateFrame, TTSSpeakFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { DTMFAggregator } from "@pipedog/core/processors/aggregators/dtmf_aggregator";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { LLMContextAggregatorPair } from "@pipedog/core/processors/aggregators/llm_response_universal";
import type { BaseTransport } from "@pipedog/core/transports/base_transport";
import { DeepgramSTTService } from "@pipedog/deepgram/stt";
import { IVRNavigator, IVRStatus, VoicemailDetector } from "@pipedog/extensions";
import { OpenAILLMService } from "@pipedog/openai/llm";

declare const transport: BaseTransport;

const stt = new DeepgramSTTService({ apiKey: process.env.DEEPGRAM_API_KEY ?? "" });
const tts = new CartesiaTTSService({ apiKey: process.env.CARTESIA_API_KEY ?? "" });
const llm = new OpenAILLMService({ apiKey: process.env.OPENAI_API_KEY ?? null });

// #region ivr
const ivrNavigator = new IVRNavigator({
  llm,
  // The goal. It is placed into the navigation instructions, so describe the
  // destination and anything the bot may say or enter along the way.
  ivrPrompt: "Reach the billing department and ask for a human agent.",
  // The IVR's prompts are read out slowly; wait longer before answering.
  ivrVadParams: new VADParams({ stopSecs: 2.0 }),
});

const ivrContext = new LLMContext();
const ivrAggregators = new LLMContextAggregatorPair(ivrContext);

const ivrPipeline = new Pipeline([
  transport.input(),
  stt,
  new DTMFAggregator(), // the IVR's own keypad tones reach the LLM as text
  ivrAggregators.user(),
  ivrNavigator, // wraps the LLM and turns <dtmf>, <ivr> and <mode> tags into frames
  tts,
  transport.output(),
  ivrAggregators.assistant(),
]);
const ivrWorker = new PipelineWorker(ivrPipeline);

// A person picked up: continue as a normal conversation.
ivrNavigator.addEventHandler("on_conversation_detected", async (_processor, history) => {
  await ivrWorker.queueFrame(
    new LLMMessagesUpdateFrame({
      messages: [{ role: "developer", content: "You are a helpful agent." }, ...history],
      runLlm: true,
    }),
  );
});

ivrNavigator.addEventHandler("on_ivr_status_changed", async (_processor, status) => {
  if (status === IVRStatus.COMPLETED) {
    // Transferred to a person: hand the call over to the conversation bot.
  } else if (status === IVRStatus.STUCK) {
    await ivrWorker.queueFrame(new EndWorkerFrame({ reason: "IVR navigation is stuck." }));
  }
});
// #endregion ivr

// #region voicemail
const voicemail = new VoicemailDetector({
  classifier: new JevClassifier({ apiKey: process.env.TYPESAFE_API_KEY ?? null }),
  decisionTimeout: 1.0, // seconds of caller silence before the verdict acts
  voicemailResponseDelay: 2.0, // seconds of silence after a voicemail verdict
});

const context = new LLMContext();
const aggregators = new LLMContextAggregatorPair(context);

const pipeline = new Pipeline([
  transport.input(),
  stt,
  voicemail.detector(), // between the STT service and the user aggregator
  aggregators.user(),
  llm,
  tts,
  voicemail.gate(), // right after the TTS service
  transport.output(),
  aggregators.assistant(),
]);
const worker = new PipelineWorker(pipeline);

voicemail.addEventHandler("on_conversation_detected", async () => {
  console.log("A person answered.");
});

voicemail.addEventHandler("on_voicemail_detected", async (processor) => {
  await processor.pushFrame(
    new TTSSpeakFrame({
      text: "Hello, this is Alex calling about your appointment. Please call me back.",
    }),
  );
  // The message is left, so the call is over.
  await processor.pushFrame(new EndWorkerFrame());
});
// #endregion voicemail

void worker;
