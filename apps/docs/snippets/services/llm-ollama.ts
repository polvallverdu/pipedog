// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/ollama.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { OLLamaLLMService } from "@pipedog/ollama/llm";

const llm = new OLLamaLLMService({
  settings: new OLLamaLLMService.Settings({
    model: "llama2",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region proxy
const remote = new OLLamaLLMService({
  baseUrl: "https://ollama.example.com/v1",
  apiKey: process.env.OLLAMA_PROXY_KEY ?? "",
  settings: new OLLamaLLMService.Settings({ model: "mistral" }),
});
// #endregion proxy

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new OLLamaLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
