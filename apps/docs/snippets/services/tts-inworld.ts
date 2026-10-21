// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/inworld.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { InworldHttpTTSService, InworldTTSService } from "@pipedog/inworld/tts";

const tts = new InworldTTSService({
  apiKey: process.env.INWORLD_API_KEY ?? "",
  settings: new InworldTTSService.Settings({
    voice: "Ashley",
    model: "inworld-tts-2",
    language: Language.EN,
    deliveryMode: "BALANCED",
  }),
});
// #endregion usage

// #region http
const httpTts = new InworldHttpTTSService({
  apiKey: process.env.INWORLD_API_KEY ?? "",
  // false posts to /tts/v1/voice and gets the audio in one piece.
  streaming: true,
  settings: new InworldHttpTTSService.Settings({ voice: "Ashley", speakingRate: 1.1 }),
});
// #endregion http

// #region update
// Applies from the next context the service opens.
const update = new TTSUpdateSettingsFrame({
  delta: new InworldTTSService.Settings({ voice: "Dennis", temperature: 0.9 }),
});
// #endregion update
