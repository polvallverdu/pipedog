// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/together.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { TogetherLLMService } from "@pipedog/together/llm";

const llm = new TogetherLLMService({
  apiKey: process.env.TOGETHER_API_KEY ?? "",
  settings: new TogetherLLMService.Settings({
    model: "zai-org/GLM-5.2",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region reasoning
const noThinking = new TogetherLLMService({
  apiKey: process.env.TOGETHER_API_KEY ?? "",
  settings: new TogetherLLMService.Settings({ reasoning: { enabled: false } }),
});
// #endregion reasoning

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new TogetherLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
