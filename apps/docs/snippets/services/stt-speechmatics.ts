// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/speechmatics.mdx. Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { SpeechmaticsSTTService, TurnDetectionMode } from "@pipedog/speechmatics/stt";

const stt = new SpeechmaticsSTTService({
  apiKey: process.env.SPEECHMATICS_API_KEY ?? "",
  settings: new SpeechmaticsSTTService.Settings({
    language: Language.EN,
    turnDetectionMode: TurnDetectionMode.EXTERNAL,
    enableDiarization: true,
    speakerActiveFormat: "@{speaker_id}: {text}",
  }),
});
// #endregion usage
