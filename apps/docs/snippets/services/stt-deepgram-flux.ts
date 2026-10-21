// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/deepgram.mdx (Flux). Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { DeepgramFluxSTTService } from "@pipedog/deepgram/flux/stt";

const stt = new DeepgramFluxSTTService({
  apiKey: process.env.DEEPGRAM_API_KEY ?? "",
  settings: new DeepgramFluxSTTService.Settings({
    model: "flux-general-en",
    eagerEotThreshold: 0.5,
    eotThreshold: 0.8,
  }),
});

stt.addEventHandler("on_end_of_turn", async (_service, transcript: string) => {
  console.log("end of turn:", transcript);
});
// #endregion usage

// #region multilingual
const multilingual = new DeepgramFluxSTTService({
  apiKey: process.env.DEEPGRAM_API_KEY ?? "",
  settings: new DeepgramFluxSTTService.Settings({
    model: "flux-general-multi",
    languageHints: [Language.EN, Language.ES],
  }),
});
// #endregion multilingual
