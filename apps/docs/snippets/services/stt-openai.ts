// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/openai.mdx. Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { OpenAISTTService } from "@pipedog/openai/stt";

const stt = new OpenAISTTService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAISTTService.Settings({
    model: "gpt-transcribe",
    language: Language.EN,
    keywords: ["pipedog", "Pipecat"],
  }),
});
// #endregion usage

// #region whisper
const whisper = new OpenAISTTService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAISTTService.Settings({ model: "whisper-1", temperature: 0 }),
  pushEmptyTranscripts: true,
});
// #endregion whisper
