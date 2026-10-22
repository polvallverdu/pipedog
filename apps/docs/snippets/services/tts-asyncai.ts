// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/asyncai.mdx. Type-checked on every docs build.

// #region usage
import { AsyncAIHttpTTSService, AsyncAITTSService } from "@pipedog/asyncai/tts";
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const tts = new AsyncAITTSService({
  apiKey: process.env.ASYNC_API_KEY ?? "",
  settings: new AsyncAITTSService.Settings({
    model: "async_flash_v1.5",
    voice: "your-voice-uuid",
    language: "en",
  }),
});
// #endregion usage

// #region http
const httpTts = new AsyncAIHttpTTSService({
  apiKey: process.env.ASYNC_API_KEY ?? "",
  settings: new AsyncAIHttpTTSService.Settings({ voice: "your-voice-uuid" }),
});
// #endregion http

// #region update
// Opens a new session, since the voice is part of the init message.
const update = new TTSUpdateSettingsFrame({
  delta: new AsyncAITTSService.Settings({ voice: "another-voice-uuid" }),
});
// #endregion update
