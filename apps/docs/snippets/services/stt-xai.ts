// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/xai.mdx. Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { XAISTTService } from "@pipedog/xai/stt";

const stt = new XAISTTService({
  apiKey: process.env.XAI_API_KEY ?? "",
  settings: new XAISTTService.Settings({ endpointing: 300 }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new XAISTTService.Settings({ endpointing: 500 }),
});
// #endregion update
