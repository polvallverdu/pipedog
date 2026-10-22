// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/bland.mdx. Type-checked on every docs build.

// #region usage
import { BlandHttpTTSService, BlandTTSService } from "@pipedog/bland/tts";
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const tts = new BlandTTSService({
  apiKey: process.env.BLAND_API_KEY ?? "",
  settings: new BlandTTSService.Settings({
    voice: "29158307-9893-4149-8a75-bc9ce313d64e",
    expressiveness: 0.6,
    stability: 0.5,
  }),
});
// #endregion usage

// #region http
const httpTts = new BlandHttpTTSService({
  apiKey: process.env.BLAND_API_KEY ?? "",
  settings: new BlandHttpTTSService.Settings({ autoFormatting: true }),
});
// #endregion http

// #region update
// Opens a new session, since the voice and controls are part of the init message.
const update = new TTSUpdateSettingsFrame({
  delta: new BlandTTSService.Settings({ stability: 0.8 }),
});
// #endregion update
