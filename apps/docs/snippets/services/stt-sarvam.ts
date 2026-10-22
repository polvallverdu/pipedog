// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/sarvam.mdx. Type-checked on every docs build.

// #region usage
import { Language } from "@pipedog/core/transcriptions/language";
import { SarvamSTTService } from "@pipedog/sarvam/stt";

const stt = new SarvamSTTService({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  settings: new SarvamSTTService.Settings({ language: Language.HI_IN }),
});

// #endregion usage

// #region realtime
import { SarvamRealtimeSTTService } from "@pipedog/sarvam/stt";

const realtime = new SarvamRealtimeSTTService({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  endpointing: "vad",
  settings: new SarvamRealtimeSTTService.Settings({ language: Language.HI_IN }),
});

// #endregion realtime

// #region update
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";

// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new SarvamRealtimeSTTService.Settings({ streamType: "fast" }),
});
// #endregion update
