// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/deepgram.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { TextAggregationMode } from "@pipedog/core/services/tts_service";
import { DeepgramFluxTTSService } from "@pipedog/deepgram/flux/tts";
import { DeepgramHttpTTSService, DeepgramTTSService } from "@pipedog/deepgram/tts";

const tts = new DeepgramTTSService({
  apiKey: process.env.DEEPGRAM_API_KEY ?? "",
  settings: new DeepgramTTSService.Settings({
    voice: "aura-2-helena-en",
    speed: 1.1,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// Any change reconnects the WebSocket with the new settings.
const update = new TTSUpdateSettingsFrame({
  delta: new DeepgramTTSService.Settings({ voice: "aura-2-thalia-en" }),
});
// #endregion update

// #region http
const httpTts = new DeepgramHttpTTSService({
  apiKey: process.env.DEEPGRAM_API_KEY ?? "",
  settings: new DeepgramHttpTTSService.Settings({ voice: "aura-2-helena-en" }),
});
// #endregion http

// #region flux
const fluxTts = new DeepgramFluxTTSService({
  apiKey: process.env.DEEPGRAM_API_KEY ?? "",
  settings: new DeepgramFluxTTSService.Settings({
    voice: "flux-alexis-en",
    speed: 1.05,
    expressivity: 1,
  }),
});

fluxTts.addEventHandler("on_connection_error", async (_service, error: string) => {
  console.error("Flux connection error:", error);
});
// #endregion flux

// #region flux-sentence
// Aggregate text into sentences instead of streaming LLM tokens.
const fluxSentences = new DeepgramFluxTTSService({
  apiKey: process.env.DEEPGRAM_API_KEY ?? "",
  textAggregationMode: TextAggregationMode.SENTENCE,
});
// #endregion flux-sentence

// #region flux-speed
// A speed change is sent on the open connection with a Configure message.
const fluxSpeed = new TTSUpdateSettingsFrame({
  delta: new DeepgramFluxTTSService.Settings({ speed: 0.9 }),
});
// #endregion flux-speed
