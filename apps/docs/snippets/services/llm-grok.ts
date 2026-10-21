// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/grok.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { GrokLLMService } from "@pipedog/xai/llm";

const llm = new GrokLLMService({
  apiKey: process.env.XAI_API_KEY ?? "",
  settings: new GrokLLMService.Settings({
    model: "grok-4.20-non-reasoning",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region reasoning
const reasoning = new GrokLLMService({
  apiKey: process.env.XAI_API_KEY ?? "",
  settings: new GrokLLMService.Settings({ model: "grok-4.6", reasoningEffort: "low" }),
});
// #endregion reasoning

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new GrokLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
