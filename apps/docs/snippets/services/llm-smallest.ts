// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/smallest.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { SmallestLLMService } from "@pipedog/smallest/llm";

const llm = new SmallestLLMService({
  apiKey: process.env.SMALLEST_API_KEY ?? "",
  settings: new SmallestLLMService.Settings({
    model: "electron",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new SmallestLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
