// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/google-vertex.mdx. Type-checked on every docs build.

// #region usage
import { GoogleVertexLLMService } from "@pipedog/google/vertex/llm";

const llm = new GoogleVertexLLMService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID ?? "",
  settings: new GoogleVertexLLMService.Settings({
    model: "gemini-3.6-flash",
    systemInstruction: "You are a helpful voice assistant.",
  }),
});
// #endregion usage

// #region credentials
// A service account key as a JSON string, e.g. from a secret store.
const fromJson = new GoogleVertexLLMService({
  credentials: process.env.GOOGLE_CREDENTIALS_JSON ?? "",
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID ?? "",
});
// #endregion credentials

// #region adc
// No credentials option: Application Default Credentials, resolved on the
// first request. Gemini 2.5 models are served from regional endpoints.
const regional = new GoogleVertexLLMService({
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID ?? "",
  location: "us-east4",
  settings: new GoogleVertexLLMService.Settings({ model: "gemini-2.5-flash" }),
});
// #endregion adc
