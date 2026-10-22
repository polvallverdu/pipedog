// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/elevenlabs.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { TextAggregationMode } from "@pipedog/core/services/tts_service";
import { Language } from "@pipedog/core/transcriptions/language";
import { ElevenLabsHttpTTSService, ElevenLabsTTSService } from "@pipedog/elevenlabs/tts";

const tts = new ElevenLabsTTSService({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  settings: new ElevenLabsTTSService.Settings({
    voice: "your-voice-id",
    model: "eleven_flash_v2_5",
    language: Language.EN,
    stability: 0.5,
    similarityBoost: 0.75,
  }),
});
// #endregion usage

// #region token
// Stream LLM tokens instead of whole sentences. autoMode then defaults to false.
const streaming = new ElevenLabsTTSService({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  textAggregationMode: TextAggregationMode.TOKEN,
  settings: new ElevenLabsTTSService.Settings({ voice: "your-voice-id" }),
});
// #endregion token

// #region http
const httpTts = new ElevenLabsHttpTTSService({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  settings: new ElevenLabsHttpTTSService.Settings({
    voice: "your-voice-id",
    optimizeStreamingLatency: 2,
    speed: 1.1,
  }),
});
// #endregion http

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// A voice-character change (stability, speed, ...) starts a new audio context;
// a voice, model or language change reconnects.
const update = new TTSUpdateSettingsFrame({
  delta: new ElevenLabsTTSService.Settings({ speed: 1.1 }),
});

// #endregion update

// #region dialogue
import { ElevenLabsDialogueTTSService } from "@pipedog/elevenlabs/dialogue/tts";

// Eleven v3 and v4 dialogue models. Needs a voice id.
const dialogue = new ElevenLabsDialogueTTSService({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  settings: new ElevenLabsDialogueTTSService.Settings({
    voice: "your-voice-id",
    model: "eleven_v4_turbo",
    stability: 0.5,
  }),
});
// #endregion dialogue
