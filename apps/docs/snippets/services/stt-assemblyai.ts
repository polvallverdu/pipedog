// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/assemblyai.mdx. Type-checked on every docs build.

// #region usage
import { AssemblyAISTTService } from "@pipedog/assemblyai/stt";
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";

const stt = new AssemblyAISTTService({
  apiKey: process.env.ASSEMBLYAI_API_KEY ?? "",
  settings: new AssemblyAISTTService.Settings({
    model: "universal-3-6-pro",
    keytermsPrompt: ["pipedog", "Pipecat"],
    languageCodes: [Language.EN, Language.ES],
  }),
});
// #endregion usage

// #region update
// Hot-updatable settings apply without reconnecting.
const update = new STTUpdateSettingsFrame({
  delta: new AssemblyAISTTService.Settings({ languageCodes: [Language.ES] }),
});
// #endregion update
