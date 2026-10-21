// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/google.mdx (Gemini TTS). Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { GeminiTTSService } from "@pipedog/google/tts";

// An apiKey selects the Gemini API (GenAI) backend.
const tts = new GeminiTTSService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  settings: new GeminiTTSService.Settings({
    model: "gemini-3.1-flash-tts-preview",
    voice: "Kore",
    language: Language.EN_US,
  }),
});
// #endregion usage

// #region cloud
// Service account credentials (and no apiKey) select Cloud Text-to-Speech.
const styled = new GeminiTTSService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  settings: new GeminiTTSService.Settings({
    voice: "Charon",
    prompt: "Say this in a calm, friendly tone.",
  }),
});
// #endregion cloud

// #region multi-speaker
// Cloud backend only. Mark up the text with the speaker aliases.
const dialogue = new GeminiTTSService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  settings: new GeminiTTSService.Settings({
    multiSpeaker: true,
    speakerConfigs: [
      { speaker_alias: "Host", speaker_id: "Kore" },
      { speaker_alias: "Guest", speaker_id: "Charon" },
    ],
  }),
});
// #endregion multi-speaker
