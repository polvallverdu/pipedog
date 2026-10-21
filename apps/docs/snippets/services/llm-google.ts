// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/google.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { GoogleLLMService, GoogleThinkingConfig } from "@pipedog/google/llm";
import { GoogleRTVIProcessor } from "@pipedog/google/rtvi";

const llm = new GoogleLLMService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  settings: new GoogleLLMService.Settings({
    model: "gemini-3.6-flash",
    systemInstruction: "You are a helpful voice assistant. Keep answers short.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region thinking
// Gemini 3 models take a thinking level.
const gemini3 = new GoogleLLMService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  settings: new GoogleLLMService.Settings({
    model: "gemini-3.6-flash",
    thinking: new GoogleThinkingConfig({ thinkingLevel: "low", includeThoughts: true }),
  }),
});

// Gemini 2.5 models take a token budget (0 turns thinking off).
const gemini25 = new GoogleLLMService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  settings: new GoogleLLMService.Settings({
    model: "gemini-2.5-flash",
    thinking: new GoogleThinkingConfig({ thinkingBudget: 1024 }),
  }),
});
// #endregion thinking

// #region search
// Tools in the SDK's camelCase shape are sent as given.
const grounded = new GoogleLLMService({
  apiKey: process.env.GOOGLE_API_KEY ?? "",
  tools: [{ googleSearch: {} }],
});

// Pass it to PipelineWorker as `rtviProcessor` to forward each
// LLMSearchResponseFrame to the client as a "bot-llm-search-response" message.
const rtvi = new GoogleRTVIProcessor();
// #endregion search

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new GoogleLLMService.Settings({ temperature: 0.2, maxTokens: 1024 }),
});
// #endregion update
