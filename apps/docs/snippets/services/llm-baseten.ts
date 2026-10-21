// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/baseten.mdx. Type-checked on every docs build.

import { BasetenLLMService } from "@pipedog/baseten/llm";
// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";

const llm = new BasetenLLMService({
  apiKey: process.env.BASETEN_API_KEY ?? "",
  settings: new BasetenLLMService.Settings({
    model: "zai-org/GLM-5.3",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
    temperature: 0.7,
  }),
});
// #endregion usage

// #region dedicated
// Replace {model_id} with your deployment's ID.
const dedicated = new BasetenLLMService({
  apiKey: process.env.BASETEN_API_KEY ?? "",
  baseUrl: "https://model-{model_id}.api.baseten.co/environments/production/sync/v1",
  settings: new BasetenLLMService.Settings({ model: "Qwen/Qwen2.5-3B-Instruct" }),
});
// #endregion dedicated

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new BasetenLLMService.Settings({ temperature: 0.2, maxTokens: 300 }),
});
// #endregion update
