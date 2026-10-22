// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/minimax.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { MiniMaxHttpTTSService } from "@pipedog/minimax/tts";

const tts = new MiniMaxHttpTTSService({
  apiKey: process.env.MINIMAX_API_KEY ?? "",
  groupId: process.env.MINIMAX_GROUP_ID ?? "",
  settings: new MiniMaxHttpTTSService.Settings({
    model: "speech-2.8-turbo",
    voice: "Calm_Woman",
    emotion: "calm",
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new MiniMaxHttpTTSService.Settings({ speed: 1.2 }),
});
// #endregion update
