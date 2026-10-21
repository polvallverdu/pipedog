// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/openai.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { OpenAILLMService } from "@pipedog/openai/llm";

const llm = new OpenAILLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAILLMService.Settings({
    model: "gpt-4.1",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region compatible
// Any server that speaks the Chat Completions API, here a local Ollama.
const local = new OpenAILLMService({
  apiKey: "ollama",
  baseUrl: "http://localhost:11434/v1",
  settings: new OpenAILLMService.Settings({ model: "llama3.2" }),
});
// #endregion compatible

// #region retry
const withRetry = new OpenAILLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  retryOnTimeout: true,
  retryTimeoutSecs: 3,
});
// #endregion retry

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new OpenAILLMService.Settings({ temperature: 0.2, maxCompletionTokens: 300 }),
});
// #endregion update
