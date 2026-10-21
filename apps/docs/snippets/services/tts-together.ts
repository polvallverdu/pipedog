// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/together.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { TogetherTTSService } from "@pipedog/together/tts";

const tts = new TogetherTTSService({
  apiKey: process.env.TOGETHER_API_KEY ?? "",
  settings: new TogetherTTSService.Settings({ voice: "af_heart" }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new TogetherTTSService.Settings({ voice: "af_bella" }),
});
// #endregion update
