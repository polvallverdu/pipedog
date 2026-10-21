// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/openrouter.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";

const llm = new OpenRouterLLMService({
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  settings: new OpenRouterLLMService.Settings({
    model: "openai/gpt-4.1",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region provider
const routed = new OpenRouterLLMService({
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  settings: new OpenRouterLLMService.Settings({
    model: "anthropic/claude-sonnet-4",
    provider: new OpenRouterLLMService.ProviderPreferences({
      sort: "latency",
      preferredMaxLatency: { p90: 1.5 },
      allowFallbacks: true,
    }),
  }),
});
// #endregion provider

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new OpenRouterLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
