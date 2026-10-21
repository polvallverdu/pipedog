// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/deepgram.mdx. Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";
import { DeepgramSTTService } from "@pipedog/deepgram/stt";

const stt = new DeepgramSTTService({
  apiKey: process.env.DEEPGRAM_API_KEY ?? "",
  settings: new DeepgramSTTService.Settings({
    model: "nova-3-general",
    language: Language.EN,
    smartFormat: true,
    keyterm: ["pipedog", "Pipecat"],
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new DeepgramSTTService.Settings({ language: Language.ES }),
});
// #endregion update
