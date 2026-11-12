// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/assemblyai.mdx. Type-checked on every docs build.

// #region usage
import { AssemblyAITTSService } from "@pipedog/assemblyai/tts";
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";

// Speaks in Audrey, the default voice.
const tts = new AssemblyAITTSService({ apiKey: process.env.ASSEMBLYAI_API_KEY ?? "" });
// #endregion usage

// #region voice
// A library voice by its slug, processed in the EU.
const eu = new AssemblyAITTSService({
  apiKey: process.env.ASSEMBLYAI_API_KEY ?? "",
  url: "wss://tts.eu.assemblyai.com/v1/ws",
  settings: new AssemblyAITTSService.Settings({ voice: "aai-jane", language: Language.EN }),
});
// #endregion voice

// #region update
// The session is configured at connect time, so a new voice reconnects.
const update = new TTSUpdateSettingsFrame({
  delta: new AssemblyAITTSService.Settings({ voice: "987db62e-a2c2-569a-9c4d-82460cdea1bd" }),
});
// #endregion update
