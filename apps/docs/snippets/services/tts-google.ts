// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/google.mdx (Cloud Text-to-Speech). Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { GoogleHttpTTSService, GoogleTTSService } from "@pipedog/google/tts";

const tts = new GoogleTTSService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  settings: new GoogleTTSService.Settings({
    voice: "en-US-Chirp3-HD-Charon",
    language: Language.EN_US,
    speakingRate: 1.1,
  }),
});
// #endregion usage

// #region http
// Any Google voice. Voices other than Chirp and Journey get SSML prosody.
const httpTts = new GoogleHttpTTSService({
  credentials: process.env.GOOGLE_CREDENTIALS_JSON ?? "",
  settings: new GoogleHttpTTSService.Settings({
    voice: "en-US-Neural2-F",
    language: Language.EN_US,
    pitch: "+2st",
    rate: "110%",
    volume: "+2dB",
  }),
});
// #endregion http

// #region update
const update = new TTSUpdateSettingsFrame({
  delta: new GoogleTTSService.Settings({ voice: "en-US-Chirp3-HD-Aoede" }),
});
// #endregion update
