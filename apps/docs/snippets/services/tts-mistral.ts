// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/mistral.mdx. Type-checked on every docs build.

// #region usage
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { MistralTTSService } from "@pipedog/mistral/tts";

const tts = new MistralTTSService({
  apiKey: process.env.MISTRAL_API_KEY ?? "",
  settings: new MistralTTSService.Settings({ voice: process.env.MISTRAL_VOICE_ID ?? "" }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new TTSUpdateSettingsFrame({
  delta: new MistralTTSService.Settings({ model: "voxtral-mini-tts-2603" }),
});
// #endregion update
