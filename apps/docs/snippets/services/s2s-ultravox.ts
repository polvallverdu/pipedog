// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/ultravox.mdx. Type-checked on every docs build.

// #region usage
import { FunctionSchema } from "@pipedog/core/adapters/llm/schemas/function_schema";
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import type { FunctionCallParams } from "@pipedog/core/services/llm_service";
import {
  AgentInputParams,
  JoinUrlInputParams,
  OneShotInputParams,
  UltravoxRealtimeLLMService,
} from "@pipedog/ultravox/llm";

const getWeather = new FunctionSchema({
  name: "get_weather",
  description: "Get the current weather for a city.",
  properties: { city: { type: "string", description: "The city name." } },
  required: ["city"],
});

// A one-off call: the system prompt, voice and tools are set here.
const llm = new UltravoxRealtimeLLMService({
  params: new OneShotInputParams({
    apiKey: process.env.ULTRAVOX_API_KEY ?? "",
    systemPrompt: "You are a helpful assistant in a voice conversation.",
    temperature: 0.3,
    maxDuration: 600, // seconds
  }),
  oneShotSelectedTools: [getWeather],
});

llm.registerFunction("get_weather", async (params: FunctionCallParams) => {
  await params.resultCallback({ city: params.arguments.city, temperature: 21 });
});
// #endregion usage

// #region agent
// A call with an agent configured in the Ultravox console.
const agent = new UltravoxRealtimeLLMService({
  params: new AgentInputParams({
    apiKey: process.env.ULTRAVOX_API_KEY ?? "",
    agentId: "your-agent-id",
    templateContext: { customerName: "Ada" },
  }),
});

// Or join a call created elsewhere, by its join URL.
const joined = new UltravoxRealtimeLLMService({
  params: new JoinUrlInputParams({ joinUrl: "wss://your-join-url" }),
});
// #endregion agent

// #region update
// Switch the model's replies to text (sends set_output_medium).
const update = new LLMUpdateSettingsFrame({
  delta: new UltravoxRealtimeLLMService.Settings({ outputMedium: "text" }),
});
// #endregion update
