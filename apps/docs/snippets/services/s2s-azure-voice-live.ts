// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/azure-voice-live.mdx. Type-checked on every docs build.

// #region usage
import {
  AzureStandardVoice,
  type ConversationItem,
  InputAudioNoiseReduction,
  InputAudioTranscription,
  SessionProperties,
  TurnDetection,
} from "@pipedog/azure/voice_live/events";
import { AzureVoiceLiveLLMService } from "@pipedog/azure/voice_live/llm";
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const llm = new AzureVoiceLiveLLMService({
  apiKey: process.env.AZURE_VOICE_LIVE_API_KEY ?? "",
  // The resource endpoint as the Azure portal shows it.
  endpoint: process.env.AZURE_VOICE_LIVE_ENDPOINT ?? "https://my-resource.services.ai.azure.com",
  settings: new AzureVoiceLiveLLMService.Settings({
    model: "gpt-4o-mini",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    // Replaces the default session properties as a whole.
    sessionProperties: new SessionProperties({
      modalities: ["text", "audio"],
      voice: new AzureStandardVoice({ name: "en-US-Ava:DragonHDLatestNeural" }),
      turnDetection: new TurnDetection({
        type: "azure_semantic_vad",
        silenceDurationMs: 500,
        removeFillerWords: true,
      }),
      inputAudioTranscription: new InputAudioTranscription({ model: "azure-speech" }),
      inputAudioNoiseReduction: new InputAudioNoiseReduction(),
    }),
  }),
});

llm.addEventHandler(
  "on_conversation_item_created",
  async (_service, itemId: string | null, _item: ConversationItem) => {
    console.log("conversation item created:", itemId);
  },
);
// #endregion usage

// #region entra
// Microsoft Entra ID instead of a key: any async function returning a bearer
// token for the https://ai.azure.com/.default scope, such as
// getBearerTokenProvider() from @azure/identity.
const entraLlm = new AzureVoiceLiveLLMService({
  endpoint: "https://my-resource.services.ai.azure.com",
  tokenProvider: async () => process.env.AZURE_ENTRA_TOKEN ?? "",
});
// #endregion entra

// #region update
// Sends a session.update to the open session.
const update = new LLMUpdateSettingsFrame({
  delta: new AzureVoiceLiveLLMService.Settings({
    systemInstruction: "Answer in Spanish from now on.",
  }),
});

// #endregion update

export { entraLlm, update };
