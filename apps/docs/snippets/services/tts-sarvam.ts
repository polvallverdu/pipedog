// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/sarvam.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { SarvamHttpTTSService, SarvamTTSService } from "@pipedog/sarvam/tts";

const tts = new SarvamTTSService({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  settings: new SarvamTTSService.Settings({
    model: "bulbul:v3",
    voice: "shubh",
    language: Language.HI_IN,
  }),
});
// #endregion usage

// #region http
const http = new SarvamHttpTTSService({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  settings: new SarvamHttpTTSService.Settings({ voice: "shubh", pace: 1.1 }),
});
// #endregion http

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new SarvamTTSService.Settings({ pace: 1.2 }),
});
// #endregion update
