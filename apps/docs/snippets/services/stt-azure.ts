// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/stt/azure.mdx. Type-checked on every docs build.

// #region usage
import { AzureSTTService } from "@pipedog/azure/stt";
import { STTUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Language } from "@pipedog/core/transcriptions/language";

const stt = new AzureSTTService({
  apiKey: process.env.AZURE_SPEECH_API_KEY ?? "",
  region: process.env.AZURE_SPEECH_REGION ?? "eastus",
  settings: new AzureSTTService.Settings({
    language: Language.EN_US,
    profanity: "raw",
    segmentationSilenceTimeoutMs: 800,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
// The service reconnects with the new language.
const update = new STTUpdateSettingsFrame({
  delta: new AzureSTTService.Settings({ language: Language.ES_ES }),
});
// #endregion update

// #region private
const privateStt = new AzureSTTService({
  apiKey: process.env.AZURE_SPEECH_API_KEY ?? "",
  privateEndpoint: "wss://my-speech.cognitiveservices.azure.com/",
  endpointId: process.env.AZURE_CUSTOM_SPEECH_ENDPOINT_ID ?? null,
});
// #endregion private
