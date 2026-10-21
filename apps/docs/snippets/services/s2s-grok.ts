// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/grok.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import {
  AudioConfiguration,
  AudioInput,
  type ConversationItem,
  InputAudioTranscription,
  SessionProperties,
  TurnDetection,
  WebSearchTool,
} from "@pipedog/xai/realtime/events";
import { GrokRealtimeLLMService } from "@pipedog/xai/realtime/llm";

const llm = new GrokRealtimeLLMService({
  apiKey: process.env.XAI_API_KEY ?? "",
  settings: new GrokRealtimeLLMService.Settings({
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    sessionProperties: new SessionProperties({
      voice: "rex",
      turnDetection: new TurnDetection({ type: "server_vad", silenceDurationMs: 500 }),
      audio: new AudioConfiguration({
        input: new AudioInput({
          transcription: new InputAudioTranscription({ model: "grok-transcribe" }),
        }),
      }),
      tools: [new WebSearchTool()],
    }),
  }),
});

llm.addEventHandler(
  "on_conversation_item_created",
  async (_service, itemId: string, _item: ConversationItem) => {
    console.log("conversation item created:", itemId);
  },
);
// #endregion usage

// #region force
// Speak a fixed line without the model (no response.create follows).
await llm.forceMessage("This call is being recorded.");
// #endregion force

// #region update
// Sends a session.update to the open session.
const update = new LLMUpdateSettingsFrame({
  delta: new GrokRealtimeLLMService.Settings({
    systemInstruction: "Answer in Spanish from now on.",
  }),
});
// #endregion update
