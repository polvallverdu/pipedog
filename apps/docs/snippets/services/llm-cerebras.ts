// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/cerebras.mdx. Type-checked on every docs build.

import { CerebrasLLMService } from "@pipedog/cerebras/llm";
// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const llm = new CerebrasLLMService({
  apiKey: process.env.CEREBRAS_API_KEY ?? "",
  settings: new CerebrasLLMService.Settings({
    model: "gpt-oss-120b",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region extra
const reasoning = new CerebrasLLMService({
  apiKey: process.env.CEREBRAS_API_KEY ?? "",
  settings: new CerebrasLLMService.Settings({ extra: { reasoning_effort: "low" } }),
});
// #endregion extra

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new CerebrasLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
