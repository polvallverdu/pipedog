// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/groq.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { GroqLLMService } from "@pipedog/groq/llm";

const llm = new GroqLLMService({
  apiKey: process.env.GROQ_API_KEY ?? "",
  settings: new GroqLLMService.Settings({
    model: "openai/gpt-oss-120b",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region reasoning
const qwen = new GroqLLMService({
  apiKey: process.env.GROQ_API_KEY ?? "",
  settings: new GroqLLMService.Settings({ model: "qwen/qwen3.8-27b", reasoningEffort: "none" }),
});
// #endregion reasoning

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new GroqLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
