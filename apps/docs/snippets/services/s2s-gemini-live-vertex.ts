// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/gemini-live-vertex.mdx. Type-checked on every docs build.

// #region usage
import { GeminiLiveVertexLLMService } from "@pipedog/google/gemini_live/vertex/llm";

const llm = new GeminiLiveVertexLLMService({
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "",
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID ?? "",
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-east4",
  systemInstruction: "You are a friendly voice assistant.",
  settings: new GeminiLiveVertexLLMService.Settings({
    model: "google/gemini-3.8-live",
    voice: "Charon",
  }),
});
// #endregion usage

// #region credentials
// A service account key as a JSON string. Leave out both credentials options
// to use Application Default Credentials.
const fromJson = new GeminiLiveVertexLLMService({
  credentials: process.env.GOOGLE_CREDENTIALS_JSON ?? "",
  projectId: process.env.GOOGLE_CLOUD_PROJECT_ID ?? "",
  location: "us-east4",
});
// #endregion credentials
