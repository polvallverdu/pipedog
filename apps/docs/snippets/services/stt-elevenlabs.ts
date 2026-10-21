// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/elevenlabs.mdx. Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import {
  CommitStrategy,
  ElevenLabsRealtimeSTTService,
  ElevenLabsSTTService,
} from "@pipedog/elevenlabs/stt";

const stt = new ElevenLabsSTTService({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  settings: new ElevenLabsSTTService.Settings({
    model: "scribe_v2",
    language: Language.EN,
    keyterms: ["pipedog", "Pipecat"],
  }),
});
// #endregion usage

// #region realtime
const realtime = new ElevenLabsRealtimeSTTService({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  settings: new ElevenLabsRealtimeSTTService.Settings({
    language: Language.EN,
    keyterms: ["pipedog"],
  }),
});
// #endregion realtime

// #region realtime-vad
// Let ElevenLabs decide when a segment ends instead of the pipeline's VAD.
const serverVad = new ElevenLabsRealtimeSTTService({
  apiKey: process.env.ELEVENLABS_API_KEY ?? "",
  commitStrategy: CommitStrategy.VAD,
  includeTimestamps: true,
  settings: new ElevenLabsRealtimeSTTService.Settings({
    vadSilenceThresholdSecs: 0.8,
    vadThreshold: 0.4,
  }),
});
// #endregion realtime-vad

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new ElevenLabsRealtimeSTTService.Settings({ language: Language.ES }),
});
// #endregion update
