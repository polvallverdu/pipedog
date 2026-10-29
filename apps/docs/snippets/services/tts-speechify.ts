// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/speechify.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { SpeechifyHttpTTSService } from "@pipedog/speechify/tts";

const tts = new SpeechifyHttpTTSService({
  apiKey: process.env.SPEECHIFY_API_KEY ?? "",
  settings: new SpeechifyHttpTTSService.Settings({
    model: "simba-3.5",
    voice: "geffen_32",
    textNormalization: true,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new SpeechifyHttpTTSService.Settings({ voice: "another-voice-id" }),
});
// #endregion update
