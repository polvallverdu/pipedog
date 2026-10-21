// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/novita.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { NovitaLLMService } from "@pipedog/novita/llm";

const llm = new NovitaLLMService({
  apiKey: process.env.NOVITA_API_KEY ?? "",
  settings: new NovitaLLMService.Settings({
    model: "moonshotai/kimi-k2.5",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new NovitaLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
