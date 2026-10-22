// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Samples for content/docs/services/llm/inception.mdx. Type-checked on every docs build.

// #region usage
import { LLMUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { InceptionLLMService } from "@pipedog/inception/llm";

const llm = new InceptionLLMService({
  apiKey: process.env.INCEPTION_API_KEY ?? "",
  settings: new InceptionLLMService.Settings({
    model: "mercury-2",
    systemInstruction: "You are a helpful assistant in a voice conversation.",
  }),
});
// #endregion usage

// #region reasoning
const fast = new InceptionLLMService({
  apiKey: process.env.INCEPTION_API_KEY ?? "",
  settings: new InceptionLLMService.Settings({ reasoningEffort: "instant" }),
});
// #endregion reasoning

// #region update
// Queue it on the worker, or push it from a processor upstream of the service.
const update = new LLMUpdateSettingsFrame({
  delta: new InceptionLLMService.Settings({ reasoningEffort: "low" }),
});
// #endregion update
