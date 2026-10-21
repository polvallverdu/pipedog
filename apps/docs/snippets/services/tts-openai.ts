// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/openai.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { OpenAITTSService } from "@pipedog/openai/tts";

const tts = new OpenAITTSService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  sampleRate: 24000,
  settings: new OpenAITTSService.Settings({
    model: "gpt-4o-mini-tts",
    voice: "marin",
    instructions: "Speak in a calm, friendly tone.",
  }),
});
// #endregion usage

// #region update
const update = new TTSUpdateSettingsFrame({
  delta: new OpenAITTSService.Settings({ voice: "cedar", speed: 1.2 }),
});
// #endregion update
