// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/nebius.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { NebiusLLMService } from "@pipedog/nebius/llm";

const llm = new NebiusLLMService({
  apiKey: process.env.NEBIUS_API_KEY ?? "",
  settings: new NebiusLLMService.Settings({
    model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new NebiusLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
