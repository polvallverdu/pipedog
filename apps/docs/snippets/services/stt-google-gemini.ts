// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/google.mdx (Gemini). Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { GeminiSTTService } from "@pipedog/google/gemini_live/stt";

const stt = new GeminiSTTService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
});

stt.addEventHandler("on_connected", async () => {
  console.log("connected to the Gemini Live API");
});
// #endregion usage

// #region hints
const hinted = new GeminiSTTService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  settings: new GeminiSTTService.Settings({
    languages: [Language.ES_ES, Language.EN_US],
    adaptationPhrases: ["pipedog", "oatmilk"],
    mode: "SMART",
  }),
});
// #endregion hints
