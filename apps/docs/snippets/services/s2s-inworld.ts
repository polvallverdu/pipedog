// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/inworld.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import {
  AudioConfiguration,
  AudioInput,
  AudioOutput,
  type ConversationItem,
  InputTranscription,
  PCMAudioFormat,
  SessionProperties,
  TurnDetection,
} from "@pipedog/inworld/realtime/events";
import { InworldRealtimeLLMService } from "@pipedog/inworld/realtime/llm";

// The shorthand options fill in the default session.
const llm = new InworldRealtimeLLMService({
  apiKey: process.env.INWORLD_API_KEY ?? "",
  llmModel: "openai/gpt-4.1-mini",
  voice: "Sarah",
  ttsModel: "inworld-tts-2",
  settings: new InworldRealtimeLLMService.Settings({
    systemInstruction: "You are a helpful assistant in a voice conversation.",
  }),
});

llm.addEventHandler(
  "on_conversation_item_created",
  async (_service, itemId: string, _item: ConversationItem) => {
    console.log("conversation item created:", itemId);
  },
);
// #endregion usage

// #region session
// A full SessionProperties replaces the defaults wholesale: give a complete config.
const custom = new InworldRealtimeLLMService({
  apiKey: process.env.INWORLD_API_KEY ?? "",
  settings: new InworldRealtimeLLMService.Settings({
    sessionProperties: new SessionProperties({
      model: "openai/gpt-4.1-mini",
      temperature: 0.7,
      outputModalities: ["audio", "text"],
      audio: new AudioConfiguration({
        input: new AudioInput({
          format: new PCMAudioFormat({ rate: 24000 }),
          transcription: new InputTranscription({ model: "inworld/inworld-stt-1" }),
          turnDetection: new TurnDetection({ type: "semantic_vad", eagerness: "low" }),
        }),
        output: new AudioOutput({
          format: new PCMAudioFormat({ rate: 24000 }),
          voice: "Sarah",
          model: "inworld-tts-2",
        }),
      }),
    }),
  }),
});
// #endregion session

// #region update
// Sends a session.update to the open session.
const update = new LLMUpdateSettingsFrame({
  delta: new InworldRealtimeLLMService.Settings({
    systemInstruction: "Answer in Spanish from now on.",
    temperature: 0.3,
  }),
});
// #endregion update
