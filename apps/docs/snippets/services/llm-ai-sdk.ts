// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/ai-sdk.mdx. Type-checked on every docs build.

// #region usage
import { google } from "@ai-sdk/google";
import { AISDKLLMService } from "@pipedog/ai-sdk";

const llm = new AISDKLLMService({
  model: google("gemini-3.5-flash-lite"),
  settings: new AISDKLLMService.Settings({
    systemInstruction: "You are a helpful voice assistant. Keep answers short.",
    temperature: 0.7,
    maxTokens: 1024,
  }),
});

// #endregion usage

// #region tools
import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { ToolsSchema } from "@pipedog/core/adapters/llm/schemas/tools_schema";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";

const weather = new FunctionSchema({
  name: "get_weather",
  description: "Get the current weather for a city",
  properties: { city: { type: "string" } },
  required: ["city"],
});

// pipedog runs the handler and sends the result back to the model.
llm.registerFunction("get_weather", async (params: FunctionCallParams) => {
  await params.resultCallback({ conditions: "sunny", celsius: 21 });
});

const context = new LLMContext({ tools: new ToolsSchema({ standardTools: [weather] }) });

// #endregion tools

// #region switch
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";

// With `provider`, a model ID in a settings update switches the model.
const switchable = new AISDKLLMService({
  model: google("gemini-3.5-flash-lite"),
  provider: google,
});
const update = new LLMUpdateSettingsFrame({
  delta: new AISDKLLMService.Settings({ model: "gemini-3.5-flash" }),
});

// Or switch to a model from any provider directly.
switchable.setLanguageModel(google("gemini-3.5-flash"));
// #endregion switch

// #region provider-options
const thinkingOff = new AISDKLLMService({
  model: google("gemini-3.5-flash-lite"),
  settings: new AISDKLLMService.Settings({
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
  }),
});
// #endregion provider-options
