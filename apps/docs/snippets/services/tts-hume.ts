// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/hume.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { HumeTTSService } from "@pipedog/hume/tts";

const tts = new HumeTTSService({
  // Defaults to the HUME_API_KEY environment variable.
  apiKey: process.env.HUME_API_KEY,
  settings: new HumeTTSService.Settings({
    // A Hume voice id. Voice names are not supported.
    voice: "your-voice-id",
    speed: 1.1,
    trailingSilence: 0.3,
  }),
});
// #endregion usage

// #region acting
// Acting directions switch Hume to Octave version 1.
const acting = new HumeTTSService({
  apiKey: process.env.HUME_API_KEY,
  settings: new HumeTTSService.Settings({
    voice: "your-voice-id",
    description: "warm, unhurried",
    temperature: 0.7,
  }),
});
// #endregion acting

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// It applies from the next request.
const update = new TTSUpdateSettingsFrame({
  delta: new HumeTTSService.Settings({ voice: "another-voice-id", speed: 0.9 }),
});
// #endregion update
