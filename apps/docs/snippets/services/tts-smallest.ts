// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/smallest.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { SmallestTTSService } from "@pipedog/smallest/tts";

const tts = new SmallestTTSService({
  apiKey: process.env.SMALLEST_API_KEY ?? "",
  settings: new SmallestTTSService.Settings({ voice: "sophia", language: Language.EN }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new SmallestTTSService.Settings({ speed: 1.1 }),
});
// #endregion update
