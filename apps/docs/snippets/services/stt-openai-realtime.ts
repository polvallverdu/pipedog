// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/openai.mdx (Realtime). Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { OpenAIRealtimeSTTService } from "@pipedog/openai/stt";

// Local VAD (the default): a VAD in the user aggregator ends each segment.
const stt = new OpenAIRealtimeSTTService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAIRealtimeSTTService.Settings({
    model: "gpt-realtime-whisper",
    language: Language.EN,
    noiseReduction: "near_field",
    delay: "low",
  }),
});
// #endregion usage

// #region server-vad
// OpenAI detects the turns. Use a model with turn detection, and no local VAD.
const serverVad = new OpenAIRealtimeSTTService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  turnDetection: { type: "server_vad", threshold: 0.5 },
  settings: new OpenAIRealtimeSTTService.Settings({ model: "gpt-transcribe" }),
});
// #endregion server-vad
