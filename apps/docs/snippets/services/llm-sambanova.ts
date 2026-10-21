// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/sambanova.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { SambaNovaLLMService } from "@pipedog/sambanova/llm";

const llm = new SambaNovaLLMService({
  apiKey: process.env.SAMBANOVA_API_KEY ?? "",
  settings: new SambaNovaLLMService.Settings({
    model: "Meta-Llama-3.3-70B-Instruct",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new SambaNovaLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
