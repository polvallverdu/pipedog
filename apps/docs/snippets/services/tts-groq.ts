// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/groq.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { GroqTTSService } from "@pipedog/groq/tts";

const tts = new GroqTTSService({
  apiKey: process.env.GROQ_API_KEY ?? "",
  settings: new GroqTTSService.Settings({ voice: "autumn" }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new GroqTTSService.Settings({ voice: "diana" }),
});
// #endregion update
