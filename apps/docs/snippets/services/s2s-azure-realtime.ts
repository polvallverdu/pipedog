// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/azure-realtime.mdx. Type-checked on every docs build.

// #region usage
import { AzureRealtimeLLMService } from "@pipedog/azure/realtime/llm";
import {
  AudioConfiguration,
  AudioInput,
  AudioOutput,
  InputAudioTranscription,
  SemanticTurnDetection,
  SessionProperties,
} from "@pipedog/openai/realtime/events";

const llm = new AzureRealtimeLLMService({
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  baseUrl: "wss://my-resource.openai.azure.com/openai/v1/realtime",
  settings: new AzureRealtimeLLMService.Settings({
    // The deployment name, sent as ?model=<deployment>.
    model: "my-gpt-realtime-deployment",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    sessionProperties: new SessionProperties({
      audio: new AudioConfiguration({
        input: new AudioInput({
          transcription: new InputAudioTranscription(),
          turnDetection: new SemanticTurnDetection({ eagerness: "medium" }),
        }),
        output: new AudioOutput({ voice: "marin" }),
      }),
    }),
  }),
});
// #endregion usage

// #region entra
// For example getBearerTokenProvider(credential, "https://ai.azure.com/.default")
// from @azure/identity. It is called once per connection.
declare const tokenProvider: () => Promise<string>;

const withEntra = new AzureRealtimeLLMService({
  tokenProvider,
  baseUrl: "wss://my-resource.openai.azure.com/openai/v1/realtime",
  settings: new AzureRealtimeLLMService.Settings({ model: "my-gpt-realtime-deployment" }),
});
// #endregion entra
