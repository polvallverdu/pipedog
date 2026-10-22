// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/smallest.mdx. Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { SmallestSTTService } from "@pipedog/smallest/stt";

const stt = new SmallestSTTService({
  apiKey: process.env.SMALLEST_API_KEY ?? "",
  settings: new SmallestSTTService.Settings({ language: Language.EN, wordTimestamps: true }),
});
// #endregion usage

// #region pulse2
const pulse2 = new SmallestSTTService({
  apiKey: process.env.SMALLEST_API_KEY ?? "",
  settings: new SmallestSTTService.Settings({ model: "pulse-2" }),
});

// #endregion pulse2

// #region update
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";

// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new SmallestSTTService.Settings({ redactPii: true }),
});
// #endregion update
