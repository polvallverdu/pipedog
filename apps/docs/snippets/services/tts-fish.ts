// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/fish.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { FishAudioTTSService } from "@pipedog/fish/tts";

const tts = new FishAudioTTSService({
  apiKey: process.env.FISH_API_KEY ?? "",
  settings: new FishAudioTTSService.Settings({
    // A voice model's reference id from the Fish Audio library.
    voice: "your-reference-id",
    model: "s2.1-pro",
    latency: "balanced",
    prosodySpeed: 1.1,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// A change to any setting reconnects, because they are all sent in the start message.
const update = new TTSUpdateSettingsFrame({
  delta: new FishAudioTTSService.Settings({ prosodySpeed: 0.9, prosodyVolume: 2 }),
});
// #endregion update
