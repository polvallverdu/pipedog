// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/together.mdx. Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { TogetherSTTService } from "@pipedog/together/stt";

const stt = new TogetherSTTService({
  apiKey: process.env.TOGETHER_API_KEY ?? "",
  settings: new TogetherSTTService.Settings({ model: "openai/whisper-large-v3" }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new TogetherSTTService.Settings({ model: "openai/whisper-large-v3" }),
});
// #endregion update
