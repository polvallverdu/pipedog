// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/qwen.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { QwenLLMService } from "@pipedog/qwen/llm";

const llm = new QwenLLMService({
  apiKey: process.env.QWEN_API_KEY ?? "",
  settings: new QwenLLMService.Settings({
    model: "qwen-plus",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new QwenLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
