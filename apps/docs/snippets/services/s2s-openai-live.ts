// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/s2s/openai-live.mdx. Type-checked on every docs build.

// #region usage
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { BackendLLMWorker } from "@pipedog/core/workers/llm/backend_llm_worker";
import { OpenAILiveLLMService } from "@pipedog/openai/live/llm";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenAIResponsesLLMService } from "@pipedog/openai/responses/llm";

const llm = new OpenAILiveLLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  settings: new OpenAILiveLLMService.Settings({
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    voice: "marin",
  }),
  delegation: new OpenAILiveLLMService.ResponsesDelegation({
    settings: new OpenAIResponsesLLMService.Settings({ model: "gpt-5.4-mini" }),
  }),
});

llm.addEventHandler("on_session_started", async (_service, session: unknown) => {
  console.log("live session started:", session);
});
// #endregion usage

// #region client
// Any pipedog LLM service can be the backend. Run the pipeline under a WorkerRunner.
const backend = new BackendLLMWorker({
  llm: new OpenAILLMService({ apiKey: process.env.OPENAI_API_KEY ?? "" }),
  context: new LLMContext({
    messages: [{ role: "system", content: "You look things up for the assistant." }],
  }),
});

const live = new OpenAILiveLLMService({
  apiKey: process.env.OPENAI_API_KEY ?? "",
  delegation: new OpenAILiveLLMService.ClientDelegation({ backend, timeoutSecs: 60 }),
});
// #endregion client
