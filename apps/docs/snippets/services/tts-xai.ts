// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/xai.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { XAIHttpTTSService, XAITTSService } from "@pipedog/xai/tts";

const tts = new XAITTSService({
  apiKey: process.env.XAI_API_KEY ?? "",
  settings: new XAITTSService.Settings({ voice: "eve" }),
});
// #endregion usage

// #region xAIHttpTTSService
const xAIHttpTTSService = new XAIHttpTTSService({
  apiKey: process.env.XAI_API_KEY ?? "",
  settings: new XAIHttpTTSService.Settings({ voice: "eve" }),
});
// #endregion xAIHttpTTSService

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new XAITTSService.Settings({ speed: 1.1 }),
});
// #endregion update
