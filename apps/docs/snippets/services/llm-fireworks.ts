// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/fireworks.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { FireworksLLMService } from "@pipedog/fireworks/llm";

const llm = new FireworksLLMService({
  apiKey: process.env.FIREWORKS_API_KEY ?? "",
  settings: new FireworksLLMService.Settings({
    model: "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new FireworksLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
