// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/cloudflare.mdx. Type-checked on every docs build.

// #region usage
import { WorkersAILLMService } from "@pipedog/cloudflare/llm";
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const llm = new WorkersAILLMService({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  settings: new WorkersAILLMService.Settings({
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region gateway
// Through an AI Gateway: the gateway's Workers AI OpenAI-compatible URL.
const viaGateway = new WorkersAILLMService({
  apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  baseUrl: `https://gateway.ai.cloudflare.com/v1/${process.env.CLOUDFLARE_ACCOUNT_ID}/my-gateway/workers-ai/v1`,
});
// #endregion gateway

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new WorkersAILLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update

void [llm, viaGateway, update];
