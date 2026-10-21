// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/openai-responses.mdx. Type-checked on every docs build.

// #region usage
import {
  OpenAIResponsesHttpLLMService,
  OpenAIResponsesLLMService,
  OpenAIResponsesReasoningConfig,
} from "@pipedog/openai/responses/llm";

const llm = new OpenAIResponsesLLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAIResponsesLLMService.Settings({
    model: "gpt-4.1",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
  }),
});
// #endregion usage

// #region reasoning
const reasoning = new OpenAIResponsesLLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAIResponsesLLMService.Settings({
    model: "gpt-5.4-mini",
    reasoning: new OpenAIResponsesReasoningConfig({ effort: "low", summary: "auto" }),
  }),
});
// #endregion reasoning

// #region http
const http = new OpenAIResponsesHttpLLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAIResponsesHttpLLMService.Settings({
    model: "gpt-4.1",
    systemInstruction: "You are a helpful assistant.",
  }),
});
// #endregion http
