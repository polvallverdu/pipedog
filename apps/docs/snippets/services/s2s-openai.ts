// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/openai.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import {
  AudioConfiguration,
  AudioInput,
  AudioOutput,
  type ConversationItem,
  InputAudioTranscription,
  SemanticTurnDetection,
  SessionProperties,
} from "@pipedog/openai/realtime/events";
import { OpenAIRealtimeLLMService } from "@pipedog/openai/realtime/llm";

const llm = new OpenAIRealtimeLLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAIRealtimeLLMService.Settings({
    model: "gpt-realtime-2.1",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    sessionProperties: new SessionProperties({
      audio: new AudioConfiguration({
        input: new AudioInput({
          transcription: new InputAudioTranscription(),
          turnDetection: new SemanticTurnDetection({ eagerness: "medium" }),
        }),
        output: new AudioOutput({ voice: "marin" }),
      }),
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

// #region update
// Sends a session.update to the open session.
const update = new LLMUpdateSettingsFrame({
  delta: new OpenAIRealtimeLLMService.Settings({
    systemInstruction: "Answer in Spanish from now on.",
  }),
});
// #endregion update
