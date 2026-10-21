// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/mistral.mdx. Type-checked on every docs build.

// #region usage
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { MistralSTTService } from "@pipedog/mistral/stt";

const stt = new MistralSTTService({
  apiKey: process.env.MISTRAL_API_KEY ?? "",
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new STTUpdateSettingsFrame({
  delta: new MistralSTTService.Settings({ model: "voxtral-mini-transcribe-realtime-2602" }),
});
// #endregion update
