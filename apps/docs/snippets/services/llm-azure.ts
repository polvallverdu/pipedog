// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/azure.mdx. Type-checked on every docs build.

// #region usage
import { AzureLLMService } from "@pipedog/azure/llm";

const llm = new AzureLLMService({
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  // Ending the endpoint in /openai/v1 selects Azure's v1 API surface.
  endpoint: "https://my-resource.openai.azure.com/openai/v1",
  settings: new AzureLLMService.Settings({
    // On Azure the model is the deployment name.
    model: "my-gpt-4.1-deployment",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region entra
// Any async function that returns a Microsoft Entra ID bearer token for the
// https://ai.azure.com/.default scope, for example
// getBearerTokenProvider(new DefaultAzureCredential(), "https://ai.azure.com/.default")
// from @azure/identity.
declare const tokenProvider: () => Promise<string>;

const withEntra = new AzureLLMService({
  tokenProvider,
  endpoint: "https://my-resource.openai.azure.com/openai/v1",
  settings: new AzureLLMService.Settings({ model: "my-gpt-4.1-deployment" }),
});
// #endregion entra

// #region dated
// Any other endpoint shape goes through the dated API (api-version 2025-04-01-preview).
const dated = new AzureLLMService({
  apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  endpoint: "https://my-resource.openai.azure.com",
  settings: new AzureLLMService.Settings({ model: "my-gpt-4.1-deployment" }),
});
// #endregion dated
