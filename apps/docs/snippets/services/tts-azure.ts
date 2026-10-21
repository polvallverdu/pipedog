// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/tts/azure.mdx. Type-checked on every docs build.

// #region usage
import { AzureHttpTTSService, AzureTTSService } from "@pipedog/azure/tts";
import { TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const tts = new AzureTTSService({
  apiKey: process.env.AZURE_SPEECH_API_KEY ?? "",
  region: process.env.AZURE_SPEECH_REGION ?? "eastus",
  settings: new AzureTTSService.Settings({
    voice: "en-US-AvaMultilingualNeural",
    language: "en-US",
    style: "cheerful",
    rate: "1.1",
  }),
});
// #endregion usage

// #region http
const httpTts = new AzureHttpTTSService({
  apiKey: process.env.AZURE_SPEECH_API_KEY ?? "",
  region: process.env.AZURE_SPEECH_REGION ?? "eastus",
  sampleRate: 24000,
});
// #endregion http

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// SSML settings apply from the next sentence.
const update = new TTSUpdateSettingsFrame({
  delta: new AzureTTSService.Settings({ language: "en-GB", forceLocale: true }),
});
// #endregion update
