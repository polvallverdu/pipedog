// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/cartesia.mdx. Type-checked on every docs build.

// #region usage
import { CartesiaSTTService } from "@pipedog/cartesia/stt";
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";

const stt = new CartesiaSTTService({
  apiKey: process.env.CARTESIA_API_KEY ?? "",
  settings: new CartesiaSTTService.Settings({
    model: "ink-whisper",
    language: Language.EN,
  }),
});
// #endregion usage

// #region keyterms
// Keyterms only work on ink-2 and ink-preview models.
const withKeyterms = new CartesiaSTTService({
  apiKey: process.env.CARTESIA_API_KEY ?? "",
  settings: new CartesiaSTTService.Settings({
    model: "ink-2",
    keyterm: ["pipedog", "Pipecat"],
  }),
});
// #endregion keyterms

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new CartesiaSTTService.Settings({ language: Language.ES }),
});
// #endregion update
