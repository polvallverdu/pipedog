// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/groq.mdx. Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { GroqSTTService } from "@pipedog/groq/stt";

const stt = new GroqSTTService({
  apiKey: process.env.GROQ_API_KEY ?? "",
  settings: new GroqSTTService.Settings({ model: "whisper-large-v3-turbo" }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new GroqSTTService.Settings({ prompt: "Pipecat, pipedog" }),
});
// #endregion update
