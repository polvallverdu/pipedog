// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/camb.mdx. Type-checked on every docs build.

// #region usage
import { CambTTSService } from "@pipedog/camb/tts";
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";

// mars-flash (22.05 kHz) is the default; mars-pro renders at 48 kHz.
const tts = new CambTTSService({
  apiKey: process.env.CAMB_API_KEY ?? "",
  settings: new CambTTSService.Settings({ model: "mars-pro", voice: 147320 }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new CambTTSService.Settings({ voice: 12345 }),
});
// #endregion update
