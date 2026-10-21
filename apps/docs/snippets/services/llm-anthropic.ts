// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/anthropic.mdx. Type-checked on every docs build.

// #region usage
import { AnthropicLLMService, AnthropicThinkingConfig } from "@pipedog/anthropic/llm";
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const llm = new AnthropicLLMService({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  settings: new AnthropicLLMService.Settings({
    model: "claude-sonnet-4-6",
    systemInstruction: "You are a helpful voice assistant. Keep answers short.",
    maxTokens: 1024,
    enablePromptCaching: true,
  }),
});

llm.addEventHandler("on_completion_timeout", async () => {
  console.log("LLM completion timed out");
});
// #endregion usage

// #region thinking
const thinkingLlm = new AnthropicLLMService({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  settings: new AnthropicLLMService.Settings({
    model: "claude-opus-4-7",
    maxTokens: 16384,
    thinking: new AnthropicThinkingConfig({ type: "adaptive", display: "summarized" }),
  }),
});
// #endregion thinking

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new AnthropicLLMService.Settings({ temperature: 0.3, maxTokens: 512 }),
});
// #endregion update
