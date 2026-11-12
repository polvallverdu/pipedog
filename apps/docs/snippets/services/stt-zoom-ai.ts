// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/zoom-ai.mdx. Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { ZoomAISTTService } from "@pipedog/zoom-ai/stt";

const stt = new ZoomAISTTService({
  apiKey: process.env.ZOOM_AI_API_KEY ?? "",
  settings: new ZoomAISTTService.Settings({
    language: Language.EN_US,
    vocabulary: ["pipedog", "Pipecat"],
  }),
});
// #endregion usage

// #region features
// Speaker labels, text polishing, and a Scribe field the settings don't cover, through `extra`.
const transcriber = new ZoomAISTTService({
  apiKey: process.env.ZOOM_AI_API_KEY ?? "",
  settings: new ZoomAISTTService.Settings({
    silenceDurationMs: 600,
    diarization: true,
    textPolishing: true,
    extra: { config: { profanity_filter: true } },
  }),
});
// #endregion features

// #region update
// A settings change reconnects with a new Scribe session.
const update = new STTUpdateSettingsFrame({
  delta: new ZoomAISTTService.Settings({ language: Language.ES }),
});
// #endregion update
