// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/perplexity.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { PerplexityAgentHttpLLMService } from "@pipedog/perplexity/llm";

const llm = new PerplexityAgentHttpLLMService({
  apiKey: process.env.PERPLEXITY_API_KEY ?? "",
  settings: new PerplexityAgentHttpLLMService.Settings({
    systemInstruction: "You are a helpful assistant in a voice conversation. Keep replies short.",
  }),
});
// #endregion usage

// #region preset
// The "high" preset chooses the model, its instructions, its search budget and its reasoning.
// `model: null` clears the default model, so the preset's own is used.
const thorough = new PerplexityAgentHttpLLMService({
  apiKey: process.env.PERPLEXITY_API_KEY ?? "",
  settings: new PerplexityAgentHttpLLMService.Settings({ preset: "high", model: null }),
});
// #endregion preset

// #region model
// Another provider's model, with web search capped at three steps and a set reasoning effort.
const pinned = new PerplexityAgentHttpLLMService({
  apiKey: process.env.PERPLEXITY_API_KEY ?? "",
  settings: new PerplexityAgentHttpLLMService.Settings({
    model: "openai/gpt-5.5",
    maxSteps: 3,
    reasoning: new PerplexityAgentHttpLLMService.ReasoningConfig({ effort: "low" }),
  }),
});
// #endregion model

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new PerplexityAgentHttpLLMService.Settings({ webSearch: false, maxSteps: 1 }),
});
// #endregion update
