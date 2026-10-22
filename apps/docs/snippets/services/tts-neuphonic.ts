// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/neuphonic.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { NeuphonicHttpTTSService, NeuphonicTTSService } from "@pipedog/neuphonic/tts";

const tts = new NeuphonicTTSService({
  apiKey: process.env.NEUPHONIC_API_KEY ?? "",
  settings: new NeuphonicTTSService.Settings({
    voice: "your-voice-id",
    language: Language.EN,
    speed: 1.0,
  }),
});
// #endregion usage

// #region http
const httpTts = new NeuphonicHttpTTSService({
  apiKey: process.env.NEUPHONIC_API_KEY ?? "",
  settings: new NeuphonicHttpTTSService.Settings({ voice: "your-voice-id" }),
});
// #endregion http

// #region update
// Reconnects the WebSocket with the new settings.
const update = new TTSUpdateSettingsFrame({
  delta: new NeuphonicTTSService.Settings({ speed: 1.2 }),
});
// #endregion update
