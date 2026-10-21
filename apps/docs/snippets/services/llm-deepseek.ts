// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/deepseek.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { DeepSeekLLMService } from "@pipedog/deepseek/llm";

const llm = new DeepSeekLLMService({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  settings: new DeepSeekLLMService.Settings({
    model: "deepseek-flash",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region thinking
const thinking = new DeepSeekLLMService({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  settings: new DeepSeekLLMService.Settings({
    thinking: new DeepSeekLLMService.ThinkingConfig({ type: "enabled" }),
  }),
});
// #endregion thinking

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new DeepSeekLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
